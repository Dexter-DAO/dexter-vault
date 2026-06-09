// Shared setupLockedClaim helper for LockedClaim tests (Task 4, Task 5, etc.).
//
// Mirrors lock-voucher.ts's happy-path setup but parameterizes the seller
// keypair so consumer tests can authorize subsequent actions (transfer,
// settle, recover) with a real Signer. Also parameterizes maturity_at +
// holder_recovery_at so settle_locked_voucher's maturity-gated path can
// be exercised.

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { DexterVault } from "../../target/types/dexter_vault";
import { Keypair, PublicKey, Transaction } from "@solana/web3.js";
import {
  enrollLockableVault,
  openTab,
  buildSessionSignedVoucher,
  buildLockVoucherIx,
} from "../lock-voucher";
import type { LockableVaultContext, SignedVoucher } from "../lock-voucher";

export interface SetupLockedClaimArgs {
  program: Program<DexterVault>;
  provider: anchor.AnchorProvider;
  sellerKeypair: Keypair;
  /** Optional override — defaults to 10_000_000n ($10) of swig wallet ATA funding. */
  usdcFundingAmount?: bigint;
  /** Optional override — defaults to 5_000_000n ($5) session cap. */
  maxAmount?: bigint;
  /** Optional override — defaults to 2_000_000n ($2) revolving capacity. */
  maxRevolvingCapacity?: bigint;
  /** Optional override — defaults to 1_000_000n ($1) crystallized into the claim. */
  cumulativeAmount?: bigint;
  /** Optional override — defaults to 1. */
  sequenceNumber?: number;
  /** Optional LockedClaim maturity_at (unix seconds). Default: null. */
  maturityAt?: bigint | null;
  /** Optional LockedClaim holder_recovery_at (unix seconds). Default: null.
   *  When both maturityAt and holderRecoveryAt are set, recovery MUST be
   *  strictly later than maturity (V0.3 Decision 4). */
  holderRecoveryAt?: bigint | null;
}

export interface SetupLockedClaimResult {
  ctx: LockableVaultContext;
  claimPda: PublicKey;
  voucher: SignedVoucher;
}

export async function setupLockedClaim(
  args: SetupLockedClaimArgs
): Promise<SetupLockedClaimResult> {
  const { program, provider, sellerKeypair } = args;

  const usdcFundingAmount = args.usdcFundingAmount ?? 10_000_000n;
  const maxAmount = args.maxAmount ?? 5_000_000n;
  const maxRevolvingCapacity = args.maxRevolvingCapacity ?? 2_000_000n;
  const cumulativeAmount = args.cumulativeAmount ?? 1_000_000n;
  const sequenceNumber = args.sequenceNumber ?? 1;
  const maturityAt = args.maturityAt ?? null;
  const holderRecoveryAt = args.holderRecoveryAt ?? null;

  const ctx = await enrollLockableVault(program, provider, {
    usdcFundingAmount,
    maxAmount,
    maxRevolvingCapacity,
  });

  await openTab(program, provider, ctx.vaultPda, cumulativeAmount, ctx.allowedCounterparty, ctx.sessionPda);

  const voucher = buildSessionSignedVoucher({
    sessionKeypair: ctx.sessionKeypair,
    channelId: ctx.channelId,
    cumulativeAmount,
    sequenceNumber,
  });

  const lockIx = await buildLockVoucherIx({
    program,
    vaultPda: ctx.vaultPda,
    swigAddress: ctx.swigAddress,
    swigWalletAddress: ctx.swigWalletAddress,
    vaultUsdcAta: ctx.sourceAta,
    voucher,
    sellerHolder: sellerKeypair.publicKey,
    dexterAuthority: provider.wallet.publicKey,
    payer: provider.wallet.publicKey,
    maturityAt,
    holderRecoveryAt,
    allowedCounterparty: ctx.allowedCounterparty,
    sessionPda: ctx.sessionPda,
  });

  const tx = new Transaction().add(voucher.precompileIx, lockIx);
  // Seller is a required signer on lock_voucher; the provider wallet pays
  // and signs as dexter_authority and payer.
  await provider.sendAndConfirm(tx, [sellerKeypair]);

  const [claimPda] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("locked-claim"),
      ctx.vaultPda.toBytes(),
      Buffer.from(voucher.voucherHash),
    ],
    program.programId
  );

  return { ctx, claimPda, voucher };
}
