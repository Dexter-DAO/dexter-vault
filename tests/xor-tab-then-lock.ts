// XOR Test 2 — settle-then-lock rejected via shared-frontier guard.
//
// The mirror of the lock-then-settle case (XOR Test 1 in lock-voucher.ts).
// Same fresh-vault scaffolding, same voucher; we tab-settle first (advancing
// session.spent), then attempt lock_voucher for the same cumulative range.
// The frontier guard `cumulative > max(spent, crystallized_cumulative)` on
// the lock side must reject because `spent` already covers the range.
//
// Both XOR tests are MANDATORY per seam spec §4. Reuses helpers from
// lock-voucher.ts so the test files stay in lockstep.

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { DexterVault } from "../target/types/dexter_vault";
import { Transaction } from "@solana/web3.js";
import { expect } from "chai";
import { makeTestProvider } from "./helpers/secp256r1";
import {
  enrollLockableVault,
  openTab,
  buildSessionSignedVoucher,
  buildLockVoucherIx,
  settleTabAtomic,
} from "./lock-voucher";

describe("XOR Test 2 — settle-then-lock rejected via frontier guard", () => {
  const provider = makeTestProvider();
  const workspaceProgram = anchor.workspace.DexterVault as Program<DexterVault>;
  const program = new anchor.Program<DexterVault>(workspaceProgram.idl, provider);

  it("rejects lock_voucher whose cumulative_amount has already been tab-settled (frontier fires on the lock path)", async function () {
    this.timeout(600_000);

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

    // Tab-settle first; this advances session.spent to 1_000_000.
    await settleTabAtomic({ program, provider, ctx, voucher });

    // Now attempt to lock the SAME voucher. The frontier guard reads
    //   max(spent=1_000_000, crystallized_cumulative=0) = 1_000_000
    // and rejects because voucher.cumulative_amount (1_000_000) is not
    // strictly greater than the frontier.
    const lockIx = await buildLockVoucherIx({
      program,
      vaultPda: ctx.vaultPda,
      swigAddress: ctx.swigAddress,
      swigWalletAddress: ctx.swigWalletAddress,
      vaultUsdcAta: ctx.sourceAta,
      voucher,
      sellerHolder: provider.wallet.publicKey,
      dexterAuthority: provider.wallet.publicKey,
      payer: provider.wallet.publicKey,
      maturityAt: null,
      holderRecoveryAt: null,
    });

    let threw = false;
    try {
      await provider.sendAndConfirm(
        new Transaction().add(voucher.precompileIx, lockIx)
      );
    } catch (err: any) {
      threw = true;
      expect(err.toString()).to.match(/LockRangeAlreadyClaimed/);
    }
    expect(threw, "lock_voucher should have been rejected post-settle").to.equal(true);
  });
});
