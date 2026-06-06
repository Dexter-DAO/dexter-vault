import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { DexterVault } from "../../target/types/dexter_vault";
import {
  Keypair,
  PublicKey,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  Transaction,
  ComputeBudgetProgram,
  Ed25519Program,
} from "@solana/web3.js";
import {
  createAtaIdempotentFinalized,
} from "./secp256r1";
import {
  bootstrapForRegister,
  registerSessionV2,
  kitInstructionsToWeb3,
} from "./register-bootstrap";

import {
  fetchSwig,
  getSignInstructions,
} from "@swig-wallet/kit";
import { address as kitAddress, createSolanaRpc } from "@solana/kit";
import {
  getTransferCheckedInstruction,
  TOKEN_PROGRAM_ADDRESS,
} from "@solana-program/token";

/**
 * Everything `settle` needs to drive a settle_tab_voucher + Swig::SignV2
 * against a vault provisioned by registerSessionWithCapacity. This is the
 * parameterized analogue of the loose `const`s swig-settle-flow.ts threads
 * through its single monolithic `it()`.
 */
export interface MeterVaultContext {
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
export async function registerSettleableVault(
  program: Program<DexterVault>,
  provider: anchor.AnchorProvider,
  opts: { maxAmount: number; maxRevolvingCapacity: number }
): Promise<MeterVaultContext> {
  const connection = provider.connection;
  const wallet = (provider.wallet as anchor.Wallet).payer;
  const maxAmount = BigInt(opts.maxAmount);
  const maxRevolvingCapacity = BigInt(opts.maxRevolvingCapacity);

  // Task 8 made register_session_key require the swig + vault_usdc_ata triple
  // and enforce the overcommit invariant against the live ATA balance. The
  // ordering is therefore: initialize_vault → swig create/add/set → fund ATA
  // → register_session_key. The bootstrap helper handles the whole swig + ATA
  // pre-step; we then register against the funded ATA.
  //
  // The settle leg of the meter test transfers via Swig::SignV2 through the
  // settle_tab_voucher marker on role 1 — the bootstrap helper's default
  // ProgramExec marker matches. FUND_AMOUNT is sized so combined =
  // maxAmount + 0 ≤ funding holds, and the settle path has headroom.
  const FUND_AMOUNT =
    BigInt(Math.max(opts.maxAmount, opts.maxRevolvingCapacity)) * 4n;

  const bootstrap = await bootstrapForRegister(program, provider, {
    usdcFundingAmount: FUND_AMOUNT,
  });

  const { sessionKeypair } = await registerSessionV2(program, provider, {
    vaultPda: bootstrap.vaultPda,
    passkey: bootstrap.passkey,
    vaultUsdcAta: bootstrap.sourceAta,
    swigAddress: bootstrap.swigAddress,
    swigWalletAddress: bootstrap.swigWalletAddress,
    maxAmount,
    maxRevolvingCapacity,
  });

  // Seller ATA — the settle credit destination. Independent of the bootstrap.
  const sellerOwner = Keypair.generate().publicKey;
  const sellerAta = await createAtaIdempotentFinalized(
    provider,
    wallet,
    bootstrap.mint,
    sellerOwner,
  );

  // Stable per-vault channel id for the voucher payload.
  const channelId = new Uint8Array(32);
  crypto.getRandomValues(channelId);

  return {
    vaultPda: bootstrap.vaultPda,
    sessionKeypair,
    channelId,
    swigAddress: bootstrap.swigAddress,
    swigWalletAddress: bootstrap.swigWalletAddress,
    swigWalletAddrKit: bootstrap.swigWalletAddrKit,
    mint: bootstrap.mint,
    sourceAta: bootstrap.sourceAta,
    sellerAta,
    decimals: bootstrap.decimals,
  };
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
export async function settle(
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
