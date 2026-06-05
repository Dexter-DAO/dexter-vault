import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { DexterVault } from "../target/types/dexter_vault";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  Transaction,
  TransactionInstruction,
  ComputeBudgetProgram,
  Ed25519Program,
} from "@solana/web3.js";
import {
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { expect } from "chai";
import {
  generateP256Keypair,
  signOperationWithPasskey,
  buildSecp256r1VerifyInstruction,
  setSwigMessage,
  P256Keypair,
} from "./helpers/secp256r1";

import {
  fetchSwig,
  findSwigPda,
  getCreateSwigInstruction,
  getAddAuthorityInstructions,
  getSignInstructions,
  getSwigWalletAddress,
} from "@swig-wallet/kit";
import {
  Actions,
  createEd25519AuthorityInfo,
  createProgramExecAuthorityInfo,
  SolInstruction,
} from "@swig-wallet/lib";
import { address as kitAddress, createSolanaRpc } from "@solana/kit";
import {
  getTransferCheckedInstruction,
  TOKEN_PROGRAM_ADDRESS,
} from "@solana-program/token";

// The settle_tab_voucher Anchor discriminator — the 8-byte instruction-data
// prefix the Swig ProgramExec authority (role 1 here) validates as a marker.
// Sourced from target/idl/dexter_vault.json (instruction settle_tab_voucher).
// This is the Tab-settle twin of FINALIZE_WITHDRAWAL_DISCRIMINATOR in
// swig-settle-flow.ts; the only difference between this settle flow and that
// withdrawal flow is which marker the ProgramExec authority is bound to.
const SETTLE_TAB_VOUCHER_DISCRIMINATOR = new Uint8Array([
  173, 22, 98, 31, 110, 129, 59, 161,
]);

// Kit v2 → Web3.js v1 instruction converter (mirrors swig-settle-flow.ts and
// dexter-api/src/swig/transactionSerializer.ts). The Swig kit returns @solana/
// kit instructions; the vault tests build legacy web3.js Transactions, so we
// bridge through SolInstruction.from.toWeb3Instruction().
function kitInstructionsToWeb3(kitInstructions: any[]): TransactionInstruction[] {
  return kitInstructions.map((ix) => {
    const sol = SolInstruction.from(ix);
    const web3 = sol.toWeb3Instruction();
    return {
      programId: new PublicKey(web3.programId.toBase58()),
      keys: web3.keys.map((k: any) => ({
        pubkey: new PublicKey(k.pubkey.toBase58()),
        isSigner: k.isSigner,
        isWritable: k.isWritable,
      })),
      data: Buffer.from(web3.data),
    } as TransactionInstruction;
  });
}

describe("revolving-meter: state shape", () => {
  const program = anchor.workspace.DexterVault as Program<DexterVault>;
  it("SessionRegistration exposes current_outstanding + max_revolving_capacity", () => {
    const idl = program.idl as any;
    // The in-memory `program.idl` is camelCased by the Anchor Program
    // constructor: the type is `sessionRegistration` and its fields are
    // `maxAmount`, `spent`, etc. (the on-disk JSON keeps snake_case). Assert
    // against the camelCase form to match what `program.idl` actually exposes.
    const s = idl.types.find((t: any) => t.name === "sessionRegistration");
    const fields = s.type.fields.map((f: any) => f.name);
    expect(fields).to.include("currentOutstanding");
    expect(fields).to.include("maxRevolvingCapacity");
    expect(fields).to.include("spent");
  });
});

// ── V2 registration message (188 bytes) ──────────────────────────────
//
// Mirrors build_registration_message in register_session_key.rs AFTER this
// task's change: domain bumped to OTS_SESSION_REGISTER_V2 and
// max_revolving_capacity (u64 LE) appended after nonce. This is deliberately
// a local copy (not the shared sessionRegisterMessage helper, which is still
// V1 / 180 bytes) so this file exercises the new byte layout end-to-end.
const REGISTER_DOMAIN_V2 = (() => {
  const buf = new Uint8Array(32);
  buf.set(new TextEncoder().encode("OTS_SESSION_REGISTER_V2"), 0);
  return buf;
})();

function sessionRegisterMessageV2(args: {
  programId: PublicKey;
  vaultPda: PublicKey;
  sessionPubkey: Uint8Array;
  maxAmount: bigint;
  expiresAt: bigint;
  allowedCounterparty: PublicKey;
  nonce: number;
  maxRevolvingCapacity: bigint;
}): Uint8Array {
  if (args.sessionPubkey.length !== 32) throw new Error("sessionPubkey must be 32 bytes");
  const buf = new Uint8Array(188);
  const view = new DataView(buf.buffer);
  let o = 0;
  buf.set(REGISTER_DOMAIN_V2, o); o += 32;
  buf.set(args.programId.toBytes(), o); o += 32;
  buf.set(args.vaultPda.toBytes(), o); o += 32;
  buf.set(args.sessionPubkey, o); o += 32;
  view.setBigUint64(o, args.maxAmount, true); o += 8;
  view.setBigInt64(o, args.expiresAt, true); o += 8;
  buf.set(args.allowedCounterparty.toBytes(), o); o += 32;
  view.setUint32(o, args.nonce >>> 0, true); o += 4;
  view.setBigUint64(o, args.maxRevolvingCapacity, true); o += 8;
  if (o !== 188) throw new Error(`session register message wrong length: ${o}`);
  return buf;
}

/**
 * Everything `settle` needs to drive a settle_tab_voucher + Swig::SignV2
 * against a vault provisioned by registerSessionWithCapacity. This is the
 * parameterized analogue of the loose `const`s swig-settle-flow.ts threads
 * through its single monolithic `it()`.
 */
interface MeterVaultContext {
  vaultPda: PublicKey;
  /** The Ed25519 session keypair registered on the vault. settle() signs the
   *  44-byte voucher with this key; the on-chain handler verifies the
   *  precompile sibling against vault.active_session.session_pubkey. The full
   *  Keypair (not just the pubkey) is retained so settle can actually sign —
   *  the prior version of this helper threw the keypair away. */
  sessionKeypair: Keypair;
  /** 32-byte channel id baked into the voucher message (channel_id || amount
   *  || sequence). Arbitrary-but-stable for the lifetime of this vault. */
  channelId: Uint8Array;
  /** Real Swig bound into the vault via set_swig; role 1 = ProgramExec(vault,
   *  settle_tab_voucher) so the Swig's validator accepts the settle ix as the
   *  marker preceding the SignV2 transfer. */
  swigAddress: PublicKey;
  /** Swig wallet PDA — owns the source ATA and is the SignV2 authority. */
  swigWalletAddress: PublicKey;
  swigWalletAddrKit: ReturnType<typeof kitAddress>;
  /** Throwaway 6-decimal mint (USDC-shaped). */
  mint: PublicKey;
  /** Swig-wallet-owned ATA funded with test tokens — the settle debit source. */
  sourceAta: PublicKey;
  /** Seller ATA — the settle credit destination. */
  sellerAta: PublicKey;
  decimals: number;
}

/**
 * The lean context the registration + open-capture tests need: a vault
 * provisioned (V3) + a session registered via the V2 188-byte passkey
 * ceremony. No Swig, no mint, no ATAs. `open()` only needs `vaultPda` and the
 * provider's dexterAuthority signer, so this is sufficient for everything that
 * does NOT call `settle`.
 */
interface LeanVaultContext {
  vaultPda: PublicKey;
  /** Retained for parity with the heavy context + any future signed-voucher
   *  test that wants to drive settle_voucher with a real session key. */
  sessionKeypair: Keypair;
  /** Stable per-vault channel id (parity with the heavy context). */
  channelId: Uint8Array;
}

/**
 * LEAN: provision a fresh vault whose dexterAuthority is the provider wallet and
 * register a session that endorses both maxAmount and maxRevolvingCapacity via
 * the V2 188-byte passkey ceremony. NOTHING ELSE — no Swig, no mint, no ATAs.
 *
 * This is what the registration + open-capture tests use: they only assert on
 * vault state (the stored cap, current_outstanding) and `open()` (settle_voucher
 * increment) which moves no tokens. Callers destructure `{ vaultPda }` or read
 * `ctx.vaultPda`.
 *
 * For the heavy apparatus the Tab settle path needs (Swig + funded ATAs), use
 * `registerSettleableVault`.
 */
async function registerSessionWithCapacity(
  program: Program<DexterVault>,
  provider: anchor.AnchorProvider,
  opts: { maxAmount: number; maxRevolvingCapacity: number }
): Promise<LeanVaultContext> {
  const identityClaim = new Uint8Array(32);
  crypto.getRandomValues(identityClaim);
  const passkey: P256Keypair = generateP256Keypair();
  const [vaultPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), Buffer.from(identityClaim.slice(0, 16))],
    program.programId
  );
  await program.methods
    .initializeVault({
      passkeyPubkey: Array.from(passkey.publicKey),
      coolingOffSeconds: 0,
      identityClaim: Array.from(identityClaim),
    })
    .accountsPartial({
      vault: vaultPda,
      payer: provider.wallet.publicKey,
      dexterAuthority: provider.wallet.publicKey,
      systemProgram: SystemProgram.programId,
    })
    .rpc();

  const sessionKeypair = Keypair.generate();
  const sessionPubkey = sessionKeypair.publicKey.toBytes();
  const allowedCounterparty = Keypair.generate().publicKey;
  const expiresAt = BigInt(Math.floor(Date.now() / 1000) + 3600);
  const nonce = 1;
  const maxAmount = BigInt(opts.maxAmount);
  const maxRevolvingCapacity = BigInt(opts.maxRevolvingCapacity);

  const msg = sessionRegisterMessageV2({
    programId: program.programId,
    vaultPda,
    sessionPubkey,
    maxAmount,
    expiresAt,
    allowedCounterparty,
    nonce,
    maxRevolvingCapacity,
  });
  const signed = signOperationWithPasskey(passkey, msg);
  const precompileIx = buildSecp256r1VerifyInstruction(
    passkey.publicKey,
    signed.signature,
    signed.precompileMessage
  );
  const vaultIx = await program.methods
    .registerSessionKey({
      sessionPubkey: Array.from(sessionPubkey),
      maxAmount: new anchor.BN(maxAmount.toString()),
      expiresAt: new anchor.BN(expiresAt.toString()),
      allowedCounterparty,
      nonce,
      maxRevolvingCapacity: new anchor.BN(maxRevolvingCapacity.toString()),
      clientDataJson: Buffer.from(signed.clientDataJSON),
      authenticatorData: Buffer.from(signed.authenticatorData),
    })
    .accountsPartial({ vault: vaultPda, instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY })
    .instruction();
  const tx = new Transaction().add(precompileIx, vaultIx);
  await provider.sendAndConfirm(tx);

  const channelId = new Uint8Array(32);
  crypto.getRandomValues(channelId);

  return { vaultPda, sessionKeypair, channelId };
}

/**
 * HEAVY: provision a fresh vault whose dexterAuthority is the provider wallet,
 * register a session that endorses both maxAmount and maxRevolvingCapacity via
 * the V2 188-byte passkey ceremony, AND stand up the real Swig + funded ATAs the
 * Tab settle path needs.
 *
 * The Swig provisioning mirrors swig-settle-flow.ts (createSwig role 0 +
 * addAuthority role 1) and enroll-test-vault.ts, except role 1's ProgramExec
 * marker is the settle_tab_voucher discriminator (not finalize_withdrawal) so
 * the Swig's validator accepts settle_tab_voucher as the instruction preceding
 * the SignV2 transfer.
 *
 * Returns a MeterVaultContext. This is what `settle` + the turnover demo need;
 * the lighter registration / open-capture tests use registerSessionWithCapacity.
 */
async function registerSettleableVault(
  program: Program<DexterVault>,
  provider: anchor.AnchorProvider,
  opts: { maxAmount: number; maxRevolvingCapacity: number }
): Promise<MeterVaultContext> {
  const connection = provider.connection;
  const wallet = (provider.wallet as anchor.Wallet).payer;
  const rpc = createSolanaRpc(connection.rpcEndpoint);

  const identityClaim = new Uint8Array(32);
  crypto.getRandomValues(identityClaim);
  const passkey: P256Keypair = generateP256Keypair();
  const [vaultPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), Buffer.from(identityClaim.slice(0, 16))],
    program.programId
  );
  await program.methods
    .initializeVault({
      passkeyPubkey: Array.from(passkey.publicKey),
      coolingOffSeconds: 0,
      identityClaim: Array.from(identityClaim),
    })
    .accountsPartial({
      vault: vaultPda,
      payer: provider.wallet.publicKey,
      dexterAuthority: provider.wallet.publicKey,
      systemProgram: SystemProgram.programId,
    })
    .rpc();

  // The session key is a REAL Ed25519 keypair we retain — settle() signs the
  // voucher with its secret. (The prior version discarded it after taking the
  // pubkey, which made settle impossible.)
  const sessionKeypair = Keypair.generate();
  const sessionPubkey = sessionKeypair.publicKey.toBytes();
  const allowedCounterparty = Keypair.generate().publicKey;
  const expiresAt = BigInt(Math.floor(Date.now() / 1000) + 3600);
  const nonce = 1;
  const maxAmount = BigInt(opts.maxAmount);
  const maxRevolvingCapacity = BigInt(opts.maxRevolvingCapacity);

  const msg = sessionRegisterMessageV2({
    programId: program.programId,
    vaultPda,
    sessionPubkey,
    maxAmount,
    expiresAt,
    allowedCounterparty,
    nonce,
    maxRevolvingCapacity,
  });
  const signed = signOperationWithPasskey(passkey, msg);
  const precompileIx = buildSecp256r1VerifyInstruction(
    passkey.publicKey,
    signed.signature,
    signed.precompileMessage
  );
  const vaultIx = await program.methods
    .registerSessionKey({
      sessionPubkey: Array.from(sessionPubkey),
      maxAmount: new anchor.BN(maxAmount.toString()),
      expiresAt: new anchor.BN(expiresAt.toString()),
      allowedCounterparty,
      nonce,
      maxRevolvingCapacity: new anchor.BN(maxRevolvingCapacity.toString()),
      clientDataJson: Buffer.from(signed.clientDataJSON),
      authenticatorData: Buffer.from(signed.authenticatorData),
    })
    .accountsPartial({ vault: vaultPda, instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY })
    .instruction();
  const tx = new Transaction().add(precompileIx, vaultIx);
  await provider.sendAndConfirm(tx);

  // ── Real Swig: role 0 bootstrap (manageAuthority) + role 1 ProgramExec
  //    (vault, settle_tab_voucher). Mirrors swig-settle-flow.ts step 2, with
  //    the settle marker instead of the finalize marker. ────────────────────
  const swigId = new Uint8Array(32);
  crypto.getRandomValues(swigId);
  const swigPdaKit = await findSwigPda(swigId);
  const swigAddress = new PublicKey(String(swigPdaKit));

  const bootstrapAuthority = createEd25519AuthorityInfo(
    Uint8Array.from(wallet.publicKey.toBytes())
  );
  const bootstrapActions = Actions.set().manageAuthority().get();

  const vaultProgramIdBytes = Uint8Array.from(program.programId.toBytes());
  const vaultAuthority = createProgramExecAuthorityInfo(
    vaultProgramIdBytes,
    SETTLE_TAB_VOUCHER_DISCRIMINATOR
  );
  const vaultActions = Actions.set().all().get();

  const createSwigCtx = await getCreateSwigInstruction({
    payer: kitAddress(wallet.publicKey.toBase58()),
    id: swigId,
    actions: bootstrapActions,
    authorityInfo: bootstrapAuthority,
  });
  const createSwigTx = new Transaction().add(
    ...kitInstructionsToWeb3([createSwigCtx])
  );
  await provider.sendAndConfirm(createSwigTx);

  // Cast through `any`: @swig-wallet/coder ships a nested copy of @solana/*
  // types, so the rpc shape isn't structurally identical even though it's the
  // same runtime object. Standard kit/coder duplicated-deps workaround
  // (identical to swig-settle-flow.ts).
  const swigForAdd = await fetchSwig(rpc as any, kitAddress(swigAddress.toBase58()));
  if (!swigForAdd) throw new Error("Swig not visible post-create");
  const addAuthorityIxs = await getAddAuthorityInstructions(
    swigForAdd,
    0, // acting role = bootstrap
    vaultAuthority,
    vaultActions,
    { payer: kitAddress(wallet.publicKey.toBase58()) }
  );
  const addTx = new Transaction().add(...kitInstructionsToWeb3(addAuthorityIxs));
  await provider.sendAndConfirm(addTx);

  // ── set_swig — passkey signs, binding the vault to the real Swig. ─────────
  const setSwigOp = setSwigMessage(swigAddress);
  const setSwigSigned = signOperationWithPasskey(passkey, setSwigOp);
  const setSwigPrecompile = buildSecp256r1VerifyInstruction(
    passkey.publicKey,
    setSwigSigned.signature,
    setSwigSigned.precompileMessage
  );
  const setSwigVaultIx = await program.methods
    .setSwig({
      swigAddress,
      clientDataJson: Buffer.from(setSwigSigned.clientDataJSON),
      authenticatorData: Buffer.from(setSwigSigned.authenticatorData),
    })
    .accountsPartial({
      vault: vaultPda,
      instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
    })
    .instruction();
  const setSwigTx = new Transaction().add(setSwigPrecompile, setSwigVaultIx);
  await provider.sendAndConfirm(setSwigTx);

  // ── Fresh mint + funded source ATA (swig wallet) + seller ATA. ────────────
  const decimals = 6; // mimic USDC
  const mint = await createMint(connection, wallet, wallet.publicKey, null, decimals);

  const swigForWallet = await fetchSwig(rpc as any, kitAddress(swigAddress.toBase58()));
  if (!swigForWallet) throw new Error("Swig not visible for wallet derivation");
  const swigWalletAddrKit = await getSwigWalletAddress(swigForWallet);
  const swigWalletAddress = new PublicKey(String(swigWalletAddrKit));

  const sourceAta = getAssociatedTokenAddressSync(
    mint,
    swigWalletAddress,
    true /* allowOwnerOffCurve — swig wallet is a PDA */
  );
  await getOrCreateAssociatedTokenAccount(connection, wallet, mint, swigWalletAddress, true);

  // Fund the source ATA with enough to cover any settle a meter test would run
  // (max_revolving_capacity is the practical ceiling on cumulative exposure).
  const FUND_AMOUNT = BigInt(Math.max(opts.maxAmount, opts.maxRevolvingCapacity)) * 4n;
  await mintTo(connection, wallet, mint, sourceAta, wallet, FUND_AMOUNT);

  const sellerOwner = Keypair.generate().publicKey;
  const sellerAta = (
    await getOrCreateAssociatedTokenAccount(connection, wallet, mint, sellerOwner)
  ).address;

  // Stable per-vault channel id for the voucher payload.
  const channelId = new Uint8Array(32);
  crypto.getRandomValues(channelId);

  return {
    vaultPda,
    sessionKeypair,
    channelId,
    swigAddress,
    swigWalletAddress,
    swigWalletAddrKit,
    mint,
    sourceAta,
    sellerAta,
    decimals,
  };
}

describe("revolving-meter: registration", () => {
  const provider = (require("./helpers/secp256r1") as any).makeTestProvider();
  // NOTE: the "state shape" describe above touches `anchor.workspace` before any
  // provider is set, which caches the workspace program against Anchor's default
  // localnet provider (http://127.0.0.1:8899). Re-binding the workspace program
  // to our mainnet test provider here keeps the registration ceremony (which
  // sends real txs) pointed at mainnet instead of dead localhost.
  const workspaceProgram = anchor.workspace.DexterVault as Program<DexterVault>;
  const program = new anchor.Program<DexterVault>(workspaceProgram.idl, provider);
  it("stores max_revolving_capacity, zeroes current_outstanding", async () => {
    const { vaultPda } = await registerSessionWithCapacity(program, provider, {
      maxAmount: 10_000_000, maxRevolvingCapacity: 2_000_000,
    });
    const s = (await program.account.vault.fetch(vaultPda)).activeSession;
    expect(s.maxRevolvingCapacity.toNumber()).to.equal(2_000_000);
    expect(s.currentOutstanding.toNumber()).to.equal(0);
    expect(s.spent.toNumber()).to.equal(0);
  });
});

/**
 * Open a tab: settle_voucher with increment=true and a value `amount`. This is
 * the credex meter's RISE seam — it raises current_outstanding on the active
 * session, admission-capped by max_revolving_capacity.
 */
async function open(
  program: Program<DexterVault>,
  provider: anchor.AnchorProvider,
  vaultPda: PublicKey,
  amount: number
): Promise<void> {
  await program.methods
    .settleVoucher({ amount: new anchor.BN(amount), increment: true })
    .accountsPartial({ vault: vaultPda, dexterAuthority: provider.wallet.publicKey })
    .rpc();
}

/**
 * Build the 44-byte canonical voucher message the session key signs:
 *   channel_id(32) || cumulative_amount(u64-LE) || sequence_number(u32-LE)
 *
 * MUST match settle_tab_voucher.rs::handler's reconstruction byte-for-byte
 * (and dexter-x402-sdk/src/tab/messages.ts::voucherPayloadMessage). If either
 * side drifts, verify_session_signed sees a different message than the
 * precompile verified and every voucher looks forged.
 */
function voucherPayloadMessage(
  channelId: Uint8Array,
  cumulativeAmount: bigint,
  sequenceNumber: number
): Uint8Array {
  if (channelId.length !== 32) throw new Error("channelId must be 32 bytes");
  const buf = new Uint8Array(44);
  const view = new DataView(buf.buffer);
  buf.set(channelId, 0);
  view.setBigUint64(32, cumulativeAmount, true);
  view.setUint32(40, sequenceNumber >>> 0, true);
  return buf;
}

/**
 * Settle a Tab voucher — the real value-moving TAB-CLOSE. This is the
 * parameterized extraction of swig-settle-flow.ts's finalize step, retargeted
 * at settle_tab_voucher (the Tab path) instead of finalize_withdrawal (the
 * withdrawal path). Three instructions, atomic:
 *
 *   [N-1] Ed25519SigVerify precompile over the 44-byte voucher message,
 *         signed by the registered session key.
 *   [N  ] vault::settle_tab_voucher — validates the precompile sibling, the
 *         session state, monotonic `spent`, and the max_amount cap; bumps
 *         `spent` to cumulativeAmount. accounts[0..1] are [swig, swig_wallet]
 *         as Swig's ProgramExec validator requires for the next ix.
 *   [N+1] swig::SignV2(TransferChecked) — Swig (role 1 = ProgramExec(vault,
 *         settle_tab_voucher)) authorizes the SPL transfer of the increment
 *         (cumulativeAmount − previously-settled) from the swig-wallet ATA to
 *         the seller ATA.
 *
 * `cumulativeAmount` is the voucher's TOTAL (monotonic) — not the increment.
 * On the first settle, `priorSpent` is 0 and the transfer moves the full
 * cumulativeAmount; on subsequent settles the on-chain `spent` is read from
 * the vault and only the delta is transferred. The on-chain handler enforces
 * cumulativeAmount > spent and cumulativeAmount <= session.max_amount.
 *
 * NOTE: contains `.rpc()`/sendAndConfirm — this is authored for post-deploy
 * verification and is NOT run on-chain in this task.
 */
async function settle(
  program: Program<DexterVault>,
  provider: anchor.AnchorProvider,
  vaultPda: PublicKey,
  cumulativeAmount: number,
  ctx: MeterVaultContext,
  opts: { sequenceNumber?: number } = {}
): Promise<void> {
  const connection = provider.connection;
  const wallet = (provider.wallet as anchor.Wallet).payer;
  const rpc = createSolanaRpc(connection.rpcEndpoint);
  const sequenceNumber = opts.sequenceNumber ?? 1;
  const cumulative = BigInt(cumulativeAmount);

  // The increment to transfer = cumulative − what the vault has already
  // settled. Read the live `spent` so repeat settles move only the delta
  // (the on-chain handler bumps `spent` to `cumulative` each time).
  const session = (await program.account.vault.fetch(vaultPda)).activeSession;
  if (!session) throw new Error("vault has no active session to settle against");
  const priorSpent = BigInt(session.spent.toString());
  if (cumulative <= priorSpent) {
    throw new Error(
      `cumulativeAmount (${cumulative}) must exceed prior spent (${priorSpent})`
    );
  }
  const increment = cumulative - priorSpent;

  // ── [N-1] Ed25519 precompile: session key signs the 44-byte voucher. ──────
  const message = voucherPayloadMessage(ctx.channelId, cumulative, sequenceNumber);
  // Ed25519Program.createInstructionWithPrivateKey produces the precompile
  // layout verify/ed25519.rs::verify_session_signed introspects:
  //   [num_sigs(1)][padding(1)][offsets(14)][pubkey(32)][sig(64)][message].
  // It signs internally with the 64-byte secretKey; the on-chain handler then
  // proves (pubkey, message) match vault.active_session.session_pubkey + the
  // reconstructed voucher.
  const ed25519Ix = Ed25519Program.createInstructionWithPrivateKey({
    privateKey: ctx.sessionKeypair.secretKey,
    message,
  });

  // ── [N] vault::settle_tab_voucher. accounts[0..1] = [swig, swig_wallet]. ──
  const settleVaultIx = await program.methods
    .settleTabVoucher({
      channelId: Array.from(ctx.channelId),
      cumulativeAmount: new anchor.BN(cumulative.toString()),
      sequenceNumber,
    })
    .accountsPartial({
      swig: ctx.swigAddress,
      swigWalletAddress: ctx.swigWalletAddress,
      vault: vaultPda,
      dexterAuthority: provider.wallet.publicKey,
      instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
    })
    .instruction();

  // ── [N+1] Swig::SignV2(TransferChecked) of the increment → seller ATA. ────
  const transferKitIx = getTransferCheckedInstruction(
    {
      source: kitAddress(ctx.sourceAta.toBase58()),
      mint: kitAddress(ctx.mint.toBase58()),
      destination: kitAddress(ctx.sellerAta.toBase58()),
      authority: ctx.swigWalletAddrKit,
      amount: increment,
      decimals: ctx.decimals,
    },
    { programAddress: TOKEN_PROGRAM_ADDRESS }
  );
  const swigForSign = await fetchSwig(rpc as any, kitAddress(ctx.swigAddress.toBase58()));
  if (!swigForSign) throw new Error("Swig not visible for sign");
  const signKitIxs = await getSignInstructions(
    swigForSign,
    1, // role 1 = vault ProgramExec(settle_tab_voucher)
    [transferKitIx],
    false,
    {
      payer: kitAddress(wallet.publicKey.toBase58()),
      // SolInstruction.from accepts a web3.js TransactionInstruction; the settle
      // vault ix becomes the ProgramExec marker preceding the SignV2.
      preInstructions: [settleVaultIx as any],
    }
  );
  const signWeb3Ixs = kitInstructionsToWeb3(signKitIxs);

  // getSignInstructions returns BOTH the preInstruction (settleVaultIx) and the
  // SignV2 in one ordered array — we don't re-add settleVaultIx manually.
  const tx = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }),
    ed25519Ix,
    ...signWeb3Ixs
  );
  await provider.sendAndConfirm(tx);
}

describe("revolving-meter: open captures exposure", () => {
  const provider = (require("./helpers/secp256r1") as any).makeTestProvider();
  // Re-bind the workspace program to our mainnet test provider (same reason as
  // the "registration" describe above): the "state shape" describe touches
  // anchor.workspace before any provider is set, caching it against dead
  // localhost. These tests send real txs and must point at the test provider.
  const workspaceProgram = anchor.workspace.DexterVault as Program<DexterVault>;
  const program = new anchor.Program<DexterVault>(workspaceProgram.idl, provider);
  it("settle_voucher(increment) raises current_outstanding by amount", async () => {
    const { vaultPda } = await registerSessionWithCapacity(program, provider, {
      maxAmount: 10_000_000, maxRevolvingCapacity: 2_000_000,
    });
    await open(program, provider, vaultPda, 1_000_000);
    const s = (await program.account.vault.fetch(vaultPda)).activeSession;
    expect(s.currentOutstanding.toNumber()).to.equal(1_000_000);
  });
  it("rejects an open that exceeds max_revolving_capacity", async () => {
    const { vaultPda } = await registerSessionWithCapacity(program, provider, {
      maxAmount: 10_000_000, maxRevolvingCapacity: 2_000_000,
    });
    await open(program, provider, vaultPda, 2_000_000);
    let threw = false;
    try { await open(program, provider, vaultPda, 1); }
    catch (e: any) { threw = true; expect(e.toString()).to.match(/RevolvingCapacityExceeded/); }
    expect(threw).to.equal(true);
  });
});

describe("revolving-meter: settle releases exposure", () => {
  const provider = (require("./helpers/secp256r1") as any).makeTestProvider();
  // Re-bind the workspace program to our mainnet test provider (same reason as
  // the describes above): the "state shape" describe touches anchor.workspace
  // before any provider is set, caching it against dead localhost. This test
  // sends real txs and must point at the test provider.
  const workspaceProgram = anchor.workspace.DexterVault as Program<DexterVault>;
  const program = new anchor.Program<DexterVault>(workspaceProgram.idl, provider);
  it("settle_tab_voucher frees current_outstanding by the settle delta", async () => {
    const ctx = await registerSettleableVault(program, provider, {
      maxAmount: 10_000_000, maxRevolvingCapacity: 2_000_000,
    });
    await open(program, provider, ctx.vaultPda, 1_000_000);
    await settle(program, provider, ctx.vaultPda, 1_000_000, ctx);
    const s = (await program.account.vault.fetch(ctx.vaultPda)).activeSession;
    expect(s.currentOutstanding.toNumber()).to.equal(0);
    expect(s.spent.toNumber()).to.equal(1_000_000);
  });
});

describe("revolving-meter: version", () => {
  const provider = (require("./helpers/secp256r1") as any).makeTestProvider();
  // Re-bind the workspace program to the mainnet test provider (same reason as
  // the describes above): touching anchor.workspace before a provider is set
  // caches it against dead localhost. registerSessionWithCapacity sends real
  // txs (initialize_vault + register_session_key) and must use the test provider.
  const workspaceProgram = anchor.workspace.DexterVault as Program<DexterVault>;
  const program = new anchor.Program<DexterVault>(workspaceProgram.idl, provider);
  it("fresh vault is V3", async () => {
    const ctx = await registerSessionWithCapacity(program, provider, {
      maxAmount: 10_000_000, maxRevolvingCapacity: 2_000_000,
    });
    expect((await program.account.vault.fetch(ctx.vaultPda)).version).to.equal(3);
  });
});

describe("revolving-meter: migration", () => {
  // IDL-presence / args-shape test ONLY — deliberately does NOT run on-chain.
  //
  // Why no end-to-end run: a "V2 vault" is the OLD (16-bytes-shorter) layout.
  // This test binary initializes vaults through the CURRENT program, which
  // writes V3 (initialize_vault sets VAULT_VERSION_V3). There is no honest way
  // to mint a genuine V2 account from a V3-initializing program, so we do NOT
  // fake one. Full migration verification (discriminator check, version-byte
  // gate, +16-byte realloc, trailing zero-fill landing current_outstanding=0 +
  // max_revolving_capacity=0, version 2->3) is exercised post-deploy against
  // the 264 real V2 vaults on mainnet — that is the only place a true V2 buffer
  // exists. Here we assert the instruction made it into the program surface.
  const program = anchor.workspace.DexterVault as Program<DexterVault>;

  it("migrateV2ToV3 is present in the IDL", () => {
    const idl = program.idl as any;
    const ix = idl.instructions.find((i: any) => i.name === "migrateV2ToV3");
    expect(ix, "migrateV2ToV3 instruction must exist in the IDL").to.not.equal(undefined);
  });

  it("migrateV2ToV3 takes vault (writable, non-signer), dexter_authority + payer signers", () => {
    const idl = program.idl as any;
    const ix = idl.instructions.find((i: any) => i.name === "migrateV2ToV3");
    const byName = (n: string) => ix.accounts.find((a: any) => a.name === n);

    const vault = byName("vault");
    expect(vault, "vault account").to.not.equal(undefined);
    expect(vault.writable).to.equal(true);
    expect(!!vault.signer).to.equal(false);

    // Authority-gating: dexter_authority must be a signer (mirrors
    // settle_voucher / rotate_dexter_authority).
    const auth = byName("dexterAuthority");
    expect(auth, "dexter_authority account").to.not.equal(undefined);
    expect(auth.signer).to.equal(true);

    // payer funds the realloc rent top-up and must sign + be writable.
    const payer = byName("payer");
    expect(payer, "payer account").to.not.equal(undefined);
    expect(payer.signer).to.equal(true);
    expect(payer.writable).to.equal(true);

    // system_program present (CPI transfer for the rent top-up).
    expect(byName("systemProgram"), "system_program account").to.not.equal(undefined);
  });
});

describe("turnover-demo: credex proof (turnover > 1)", () => {
  const provider = (require("./helpers/secp256r1") as any).makeTestProvider();
  // Re-bind workspace program to the mainnet test provider (same reason as the
  // settle describe above).
  const workspaceProgram = anchor.workspace.DexterVault as Program<DexterVault>;
  const program = new anchor.Program<DexterVault>(workspaceProgram.idl, provider);

  it("same $2 capacity clears $10 of settled claims => 5x turnover", async function () {
    this.timeout(600_000); // ~20 mainnet txs @ ~13s each

    const REVOLVING = 2_000_000;   // $2 revolving capacity
    const CLAIM = 1_000_000;       // $1 per tab
    const ROUNDS = 10;             // 10 settled claims = $10 cleared

    console.log(`\n=== CREDEX TURNOVER DEMO ===`);
    console.log(`capacity=$${REVOLVING / 1e6}  claim=$${CLAIM / 1e6}  rounds=${ROUNDS}`);
    console.log(`standing up settleable vault (Swig + mint + ATAs)...`);
    const ctx = await registerSettleableVault(program, provider, {
      maxAmount: 100_000_000,        // $100 lifetime cap (room for 10 cumulative settles)
      maxRevolvingCapacity: REVOLVING,
    });
    console.log(`vault: ${ctx.vaultPda.toBase58()}`);

    let cumulative = 0;
    for (let i = 1; i <= ROUNDS; i++) {
      // OPEN: settle_voucher(increment) raises current_outstanding by CLAIM
      await open(program, provider, ctx.vaultPda, CLAIM);
      let s = (await program.account.vault.fetch(ctx.vaultPda)).activeSession;
      const outAfterOpen = s.currentOutstanding.toNumber();

      // SETTLE: settle_tab_voucher with the running cumulative total.
      // Each settle moves the delta (cumulative - spent = CLAIM) and frees
      // current_outstanding back down.
      cumulative += CLAIM;
      await settle(program, provider, ctx.vaultPda, cumulative, ctx, { sequenceNumber: i });
      s = (await program.account.vault.fetch(ctx.vaultPda)).activeSession;
      console.log(
        `round ${String(i).padStart(2)}: open->outstanding=$${outAfterOpen / 1e6}  ` +
        `settle->outstanding=$${s.currentOutstanding.toNumber() / 1e6}  ` +
        `spent=$${s.spent.toNumber() / 1e6}`
      );
    }

    const s = (await program.account.vault.fetch(ctx.vaultPda)).activeSession;
    const settled = s.spent.toNumber();
    const capacity = s.maxRevolvingCapacity.toNumber();
    const turnover = settled / capacity;
    console.log(`\n*** CREDEX PROOF: settled=$${settled / 1e6}  capacity=$${capacity / 1e6}  turnover=${turnover}x ***\n`);

    expect(settled).to.equal(ROUNDS * CLAIM);            // $10 cleared
    expect(s.currentOutstanding.toNumber()).to.equal(0); // fully revolved
    expect(turnover).to.be.greaterThan(1);               // THE clearing proof
  });
});
