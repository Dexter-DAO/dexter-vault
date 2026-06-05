// transfer_lock_ownership integration tests (mainnet).
//
// Three scenarios cover Task 4 of the Phase 1 LockedClaim plan:
//   1. Happy path — transfer claim from seller to financier; status stays
//      Pending; vault accumulators (outstanding_locked_amount,
//      total_crystallized_amount) unchanged.
//   2. Non-holder rejection — an imposter (not current_holder) attempts the
//      transfer; the Anchor constraint rejects.
//   3. Deferred — transfer-then-settle proof lands in Task 5's
//      settle_locked_voucher tests.
//
// Reuses the lock_voucher enrollment helpers (re-exported from
// tests/lock-voucher.ts) so the fresh-vault provisioning shape is identical.
// V0.3 Decision 1: this instruction MUST NOT touch any vault accumulator.
// V0.3 Decision 6: this instruction MUST NOT mutate `status`.

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { DexterVault } from "../target/types/dexter_vault";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import { expect } from "chai";
import { makeTestProvider } from "./helpers/secp256r1";
import {
  enrollLockableVault,
  openTab,
  buildSessionSignedVoucher,
  buildLockVoucherIx,
} from "./lock-voucher";
import type { LockableVaultContext, SignedVoucher } from "./lock-voucher";

// Lock a voucher and return the LockedClaim PDA + the seller's keypair (which
// owns the claim post-creation). This mirrors lock-voucher.ts's happy-path
// setup but parameterizes the seller keypair so transfer tests can authorize
// the transfer with a real Signer.
async function setupLockedClaim(args: {
  program: Program<DexterVault>;
  provider: anchor.AnchorProvider;
  sellerKeypair: Keypair;
}): Promise<{
  ctx: LockableVaultContext;
  claimPda: PublicKey;
  voucher: SignedVoucher;
}> {
  const { program, provider, sellerKeypair } = args;

  const ctx = await enrollLockableVault(program, provider, {
    usdcFundingAmount: 10_000_000n,
    maxAmount: 5_000_000n,
    maxRevolvingCapacity: 2_000_000n,
  });

  await openTab(program, provider, ctx.vaultPda, 1_000_000n);

  const voucher = buildSessionSignedVoucher({
    sessionKeypair: ctx.sessionKeypair,
    channelId: ctx.channelId,
    cumulativeAmount: 1_000_000n,
    sequenceNumber: 1,
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
    maturityAt: null,
    holderRecoveryAt: null,
  });

  const tx = new Transaction().add(voucher.precompileIx, lockIx);
  // Seller is a required signer on lock_voucher; the wallet pays + signs as
  // dexter_authority and payer.
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

describe("transfer_lock_ownership — happy path", () => {
  const provider = makeTestProvider();
  const workspaceProgram = anchor.workspace.DexterVault as Program<DexterVault>;
  const program = new anchor.Program<DexterVault>(workspaceProgram.idl, provider);

  it("transfers a Pending claim from seller to financier; status stays Pending; vault accumulators unchanged", async function () {
    this.timeout(600_000);

    const sellerKeypair = Keypair.generate();
    const financier = Keypair.generate();

    const { ctx, claimPda } = await setupLockedClaim({
      program,
      provider,
      sellerKeypair,
    });

    // Snapshot accumulators pre-transfer.
    const vaultPre = await program.account.vault.fetch(ctx.vaultPda);
    const outstandingPre = (vaultPre as any).outstandingLockedAmount.toString();
    const crystallizedPre = (vaultPre as any).totalCrystallizedAmount.toString();
    const settledPre = (vaultPre as any).totalSettledAmount.toString();

    // Sanity: the claim is owned by sellerKeypair pre-transfer.
    const claimPre = await program.account.lockedClaim.fetch(claimPda);
    expect(claimPre.currentHolder.toString()).to.equal(
      sellerKeypair.publicKey.toString()
    );
    expect(claimPre.status).to.deep.equal({ pending: {} });

    // Transfer.
    await program.methods
      .transferLockOwnership({ newHolder: financier.publicKey })
      .accountsPartial({
        claim: claimPda,
        currentHolder: sellerKeypair.publicKey,
      })
      .signers([sellerKeypair])
      .rpc();

    // Claim: current_holder mutated, status preserved, amount preserved.
    const claimPost = await program.account.lockedClaim.fetch(claimPda);
    expect(claimPost.currentHolder.toString()).to.equal(
      financier.publicKey.toString()
    );
    expect(claimPost.status).to.deep.equal({ pending: {} });
    expect(claimPost.amount.toString()).to.equal(claimPre.amount.toString());
    expect(claimPost.voucherHash).to.deep.equal(claimPre.voucherHash);
    expect(claimPost.vault.toString()).to.equal(claimPre.vault.toString());
    expect(claimPost.settledAt).to.equal(null);
    expect(claimPost.recoveredAt).to.equal(null);

    // Vault: accumulators untouched (V0.3 Decision 1).
    const vaultPost = await program.account.vault.fetch(ctx.vaultPda);
    expect((vaultPost as any).outstandingLockedAmount.toString()).to.equal(
      outstandingPre
    );
    expect((vaultPost as any).totalCrystallizedAmount.toString()).to.equal(
      crystallizedPre
    );
    expect((vaultPost as any).totalSettledAmount.toString()).to.equal(settledPre);
  });
});

describe("transfer_lock_ownership — non-holder rejection", () => {
  const provider = makeTestProvider();
  const workspaceProgram = anchor.workspace.DexterVault as Program<DexterVault>;
  const program = new anchor.Program<DexterVault>(workspaceProgram.idl, provider);

  it("rejects a transfer signed by an imposter (not the current_holder)", async function () {
    this.timeout(600_000);

    const sellerKeypair = Keypair.generate();
    const imposter = Keypair.generate();
    const financier = Keypair.generate();

    const { claimPda } = await setupLockedClaim({
      program,
      provider,
      sellerKeypair,
    });

    let threw = false;
    try {
      await program.methods
        .transferLockOwnership({ newHolder: financier.publicKey })
        .accountsPartial({
          claim: claimPda,
          currentHolder: imposter.publicKey,
        })
        .signers([imposter])
        .rpc();
    } catch (err: any) {
      threw = true;
      // The constraint `claim.current_holder == current_holder.key()` raises
      // `PasskeyVerificationFailed` per the handler's `@` mapping. Anchor may
      // surface the constraint failure as either the mapped name or a raw
      // constraint error — match either form.
      expect(err.toString()).to.match(/PasskeyVerificationFailed|ConstraintRaw/);
    }
    expect(
      threw,
      "transfer_lock_ownership should have been rejected (non-holder)"
    ).to.equal(true);
  });
});

describe("transfer_lock_ownership + settle by new holder (deferred)", () => {
  it.skip(
    "the full transfer-then-settle proof lands in Task 5's settle_locked_voucher tests",
    () => {
      // Intentional skip — Task 5 will lock, transfer, and have the new
      // holder settle, asserting that the financier (post-transfer) is the
      // sole party that can settle and that the seller can no longer do so.
    }
  );
});
