// Shared bootstrap helper for `register_session_key` tests.
//
// As of Task 8 (V0.3 Decision 1), `register_session_key` requires three
// additional accounts — vault_usdc_ata + swig + swig_wallet_address — and
// enforces the overcommit invariant against `vault_usdc_ata.amount`. That
// means every test that registers a session MUST first stand up:
//
//   1. a V4 vault bound to a fresh passkey
//   2. a real Swig (role 0 manageAuthority + role 1 ProgramExec marker)
//   3. set_swig binding vault ↔ swig
//   4. a mint + a swig-wallet-owned source ATA, optionally funded
//
// This helper centralizes that bootstrap so individual test files don't each
// recreate the (subtle) ordering and replica-lag guards.
//
// The role-1 ProgramExec marker is configurable so callers that need the
// settle_tab_voucher marker (settle/lock tests) get it; callers that don't
// care (registration-only tests) get a vanilla ProgramExec.

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { DexterVault } from "../../target/types/dexter_vault";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  createMint,
  mintTo,
  getAccount,
} from "@solana/spl-token";
import {
  fetchSwig,
  findSwigPda,
  getCreateSwigInstruction,
  getAddAuthorityInstructions,
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
  generateP256Keypair,
  signOperationWithPasskey,
  buildSecp256r1VerifyInstruction,
  setSwigMessage,
  P256Keypair,
  pollUntilAccountExists,
  pollUntilAccount,
  createAtaIdempotentFinalized,
} from "./secp256r1";

// settle_tab_voucher's Anchor discriminator — the 8-byte instruction-data
// prefix the swig ProgramExec authority (role 1) validates as a marker.
export const SETTLE_TAB_VOUCHER_DISCRIMINATOR = new Uint8Array([
  173, 22, 98, 31, 110, 129, 59, 161,
]);

// V2 188-byte session registration domain + builder (matches
// register_session_key.rs::build_registration_message under V2 / 188 bytes).
const REGISTER_DOMAIN_V2 = (() => {
  const buf = new Uint8Array(32);
  buf.set(new TextEncoder().encode("OTS_SESSION_REGISTER_V2"), 0);
  return buf;
})();

export function sessionRegisterMessageV2(args: {
  programId: PublicKey;
  vaultPda: PublicKey;
  sessionPubkey: Uint8Array;
  maxAmount: bigint;
  expiresAt: bigint;
  allowedCounterparty: PublicKey;
  nonce: number;
  maxRevolvingCapacity: bigint;
}): Uint8Array {
  const buf = new Uint8Array(188);
  const view = new DataView(buf.buffer);
  let o = 0;
  buf.set(REGISTER_DOMAIN_V2, o);
  o += 32;
  buf.set(args.programId.toBytes(), o);
  o += 32;
  buf.set(args.vaultPda.toBytes(), o);
  o += 32;
  buf.set(args.sessionPubkey, o);
  o += 32;
  view.setBigUint64(o, args.maxAmount, true);
  o += 8;
  view.setBigInt64(o, args.expiresAt, true);
  o += 8;
  buf.set(args.allowedCounterparty.toBytes(), o);
  o += 32;
  view.setUint32(o, args.nonce >>> 0, true);
  o += 4;
  view.setBigUint64(o, args.maxRevolvingCapacity, true);
  o += 8;
  if (o !== 188) throw new Error(`V2 register message wrong length: ${o}`);
  return buf;
}

// Kit v2 → web3.js v1 instruction converter (same shape lock-voucher/
// revolving-meter use; kit's nested @solana/* type duplication forces this).
export function kitInstructionsToWeb3(
  kitInstructions: any[],
): TransactionInstruction[] {
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

/**
 * State produced by `bootstrapForRegister`: vault + passkey + the full
 * swig + ATA apparatus the new `register_session_key` gate requires.
 *
 * Caller then drives `registerSessionV2` (or repeated registrations after
 * intervening revoke / lock activity) against this state.
 */
export interface RegisterReadyVault {
  vaultPda: PublicKey;
  passkey: P256Keypair;
  swigAddress: PublicKey;
  swigWalletAddress: PublicKey;
  swigWalletAddrKit: ReturnType<typeof kitAddress>;
  mint: PublicKey;
  /** swig-wallet-owned source ATA — register reads its `amount` field. */
  sourceAta: PublicKey;
  /** Decimals on the test mint (USDC parity → 6). */
  decimals: number;
}

export interface BootstrapOpts {
  /** Funding amount for the swig wallet ATA, in 6-decimal token units.
   *  This is the live `vault_usdc_ata.amount` the overcommit gate reads. */
  usdcFundingAmount: bigint;
  /** Role-1 ProgramExec marker. Defaults to settle_tab_voucher (matches
   *  lock_voucher / settle tests). */
  programExecMarker?: Uint8Array;
}

/**
 * Provision a V4 vault, stand up the real Swig (role 0 + role 1 ProgramExec),
 * bind via `set_swig`, mint a USDC-parity token, create + fund the swig-
 * wallet-owned source ATA. After this returns, `register_session_key` will
 * have its three new accounts available and `vault_usdc_ata.amount` set to
 * `usdcFundingAmount`.
 */
export async function bootstrapForRegister(
  program: Program<DexterVault>,
  provider: anchor.AnchorProvider,
  opts: BootstrapOpts,
): Promise<RegisterReadyVault> {
  const connection = provider.connection;
  const wallet = (provider.wallet as anchor.Wallet).payer;
  const rpc = createSolanaRpc(connection.rpcEndpoint);

  const identityClaim = new Uint8Array(32);
  crypto.getRandomValues(identityClaim);
  const passkey: P256Keypair = generateP256Keypair();
  const [vaultPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), Buffer.from(identityClaim.slice(0, 16))],
    program.programId,
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
  await pollUntilAccountExists(connection, vaultPda);

  // ── Real Swig: role 0 bootstrap (manageAuthority) + role 1 ProgramExec
  //    with caller-chosen marker (defaults to settle_tab_voucher). ──────────
  const swigId = new Uint8Array(32);
  crypto.getRandomValues(swigId);
  const swigPdaKit = await findSwigPda(swigId);
  const swigAddress = new PublicKey(String(swigPdaKit));

  const bootstrapAuthority = createEd25519AuthorityInfo(
    Uint8Array.from(wallet.publicKey.toBytes()),
  );
  const bootstrapActions = Actions.set().manageAuthority().get();

  const vaultProgramIdBytes = Uint8Array.from(program.programId.toBytes());
  const marker = opts.programExecMarker ?? SETTLE_TAB_VOUCHER_DISCRIMINATOR;
  const vaultAuthority = createProgramExecAuthorityInfo(
    vaultProgramIdBytes,
    marker,
  );
  const vaultActions = Actions.set().all().get();

  const createSwigCtx = await getCreateSwigInstruction({
    payer: kitAddress(wallet.publicKey.toBase58()),
    id: swigId,
    actions: bootstrapActions,
    authorityInfo: bootstrapAuthority,
  });
  await provider.sendAndConfirm(
    new Transaction().add(...kitInstructionsToWeb3([createSwigCtx])),
  );

  const swigForAdd = await fetchSwig(
    rpc as any,
    kitAddress(swigAddress.toBase58()),
  );
  if (!swigForAdd) throw new Error("Swig not visible post-create");
  const addAuthorityIxs = await getAddAuthorityInstructions(
    swigForAdd,
    0,
    vaultAuthority,
    vaultActions,
    { payer: kitAddress(wallet.publicKey.toBase58()) },
  );
  await provider.sendAndConfirm(
    new Transaction().add(...kitInstructionsToWeb3(addAuthorityIxs)),
  );

  // ── set_swig — passkey signs, binding the vault to the real Swig. ────────
  const setSwigOp = setSwigMessage(swigAddress);
  const setSwigSigned = signOperationWithPasskey(passkey, setSwigOp);
  const setSwigPrecompile = buildSecp256r1VerifyInstruction(
    passkey.publicKey,
    setSwigSigned.signature,
    setSwigSigned.precompileMessage,
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
  await provider.sendAndConfirm(
    new Transaction().add(setSwigPrecompile, setSwigVaultIx),
  );

  // ── Mint + funded swig-wallet ATA. ────────────────────────────────────────
  const decimals = 6;
  const mint = await createMint(
    connection,
    wallet,
    wallet.publicKey,
    null,
    decimals,
  );
  await pollUntilAccountExists(connection, mint);

  const swigForWallet = await fetchSwig(
    rpc as any,
    kitAddress(swigAddress.toBase58()),
  );
  if (!swigForWallet) throw new Error("Swig not visible for wallet derivation");
  const swigWalletAddrKit = await getSwigWalletAddress(swigForWallet);
  const swigWalletAddress = new PublicKey(String(swigWalletAddrKit));

  const sourceAta = await createAtaIdempotentFinalized(
    provider,
    wallet,
    mint,
    swigWalletAddress,
    true /* allowOwnerOffCurve — swig wallet is a PDA */,
  );

  if (opts.usdcFundingAmount > 0n) {
    await mintTo(
      connection,
      wallet,
      mint,
      sourceAta,
      wallet,
      opts.usdcFundingAmount,
    );
    await pollUntilAccount(
      () => getAccount(connection, sourceAta, "finalized"),
      (acct) => acct.amount >= opts.usdcFundingAmount,
    );
  }

  return {
    vaultPda,
    passkey,
    swigAddress,
    swigWalletAddress,
    swigWalletAddrKit,
    mint,
    sourceAta,
    decimals,
  };
}

/**
 * Build + submit a V2/188-byte session registration against a vault that has
 * already been bootstrapped (swig set, source ATA funded). Returns the
 * session keypair the caller can retain to sign vouchers.
 */
export interface RegisterSessionV2Opts {
  vaultPda: PublicKey;
  passkey: P256Keypair;
  /** The swig-wallet-owned source ATA — the gate reads its `amount`. */
  vaultUsdcAta: PublicKey;
  swigAddress: PublicKey;
  swigWalletAddress: PublicKey;
  sessionKeypair?: Keypair;
  maxAmount: bigint;
  maxRevolvingCapacity: bigint;
  allowedCounterparty?: PublicKey;
  expiresAt?: bigint;
  nonce?: number;
}

export interface RegisteredSession {
  sessionKeypair: Keypair;
  signature: string;
}

export async function registerSessionV2(
  program: Program<DexterVault>,
  provider: anchor.AnchorProvider,
  opts: RegisterSessionV2Opts,
): Promise<RegisteredSession> {
  const sessionKeypair = opts.sessionKeypair ?? Keypair.generate();
  const sessionPubkey = sessionKeypair.publicKey.toBytes();
  const allowedCounterparty =
    opts.allowedCounterparty ?? Keypair.generate().publicKey;
  const expiresAt =
    opts.expiresAt ?? BigInt(Math.floor(Date.now() / 1000) + 3600);
  const nonce = opts.nonce ?? 1;

  const msg = sessionRegisterMessageV2({
    programId: program.programId,
    vaultPda: opts.vaultPda,
    sessionPubkey,
    maxAmount: opts.maxAmount,
    expiresAt,
    allowedCounterparty,
    nonce,
    maxRevolvingCapacity: opts.maxRevolvingCapacity,
  });
  const signed = signOperationWithPasskey(opts.passkey, msg);
  const precompileIx = buildSecp256r1VerifyInstruction(
    opts.passkey.publicKey,
    signed.signature,
    signed.precompileMessage,
  );
  const vaultIx = await program.methods
    .registerSessionKey({
      sessionPubkey: Array.from(sessionPubkey),
      maxAmount: new anchor.BN(opts.maxAmount.toString()),
      expiresAt: new anchor.BN(expiresAt.toString()),
      allowedCounterparty,
      nonce,
      maxRevolvingCapacity: new anchor.BN(opts.maxRevolvingCapacity.toString()),
      clientDataJson: Buffer.from(signed.clientDataJSON),
      authenticatorData: Buffer.from(signed.authenticatorData),
    })
    .accountsPartial({
      vault: opts.vaultPda,
      vaultUsdcAta: opts.vaultUsdcAta,
      swig: opts.swigAddress,
      swigWalletAddress: opts.swigWalletAddress,
      instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
    })
    .instruction();
  const tx = new Transaction().add(precompileIx, vaultIx);
  const signature = await provider.sendAndConfirm(tx);
  return { sessionKeypair, signature };
}
