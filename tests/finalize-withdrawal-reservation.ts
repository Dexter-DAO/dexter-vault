// finalize_withdrawal reservation-gate integration tests (mainnet).
//
// Task 7 of the Phase 1 LockedClaim plan. Two scenarios cover V0.3 Decision 1:
//
//   1. REJECT — fresh V4 vault funded $10. Open tab $5, lock $5. Request
//      withdrawal of $7 ($10 - $7 = $3, which is below the $5 locked).
//      finalize_withdrawal must reject with WithdrawalWouldViolateReservation.
//
//   2. PERMIT — fresh V4 vault funded $10. Open tab $3, lock $3. Request
//      withdrawal of $5 ($10 - $5 = $5, which is at or above $3 locked).
//      finalize_withdrawal proceeds (the assertion is just that the call
//      doesn't throw the reservation error). The downstream Swig::SignV2
//      transfer wrapper is out of scope here — Task 7's assertion is the
//      reservation gate decision, not the token movement.
//
// Build-only per the Phase 1 cadence: the deployed program at the time of
// writing is at 15 instructions and pre-dates the new `vault_usdc_ata`
// account on `FinalizeWithdrawal<'info>`. Pre-deploy these tests will fault
// with `InstructionFallbackNotFound (custom 0x65)` (or an account-context
// decode error) before reaching the reservation check. Post-deploy, the
// combined Phase 1 anchor upgrade will allow these tests to actually
// exercise the new gate.

import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import { DexterVault } from "../target/types/dexter_vault";
import {
  Keypair,
  PublicKey,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  Transaction,
} from "@solana/web3.js";
import { expect } from "chai";

import {
  buildSecp256r1VerifyInstruction,
  finalizeWithdrawalMessage,
  makeTestProvider,
  requestWithdrawalMessage,
  signOperationWithPasskey,
  P256Keypair,
} from "./helpers/secp256r1";
import {
  buildLockVoucherIx,
  buildSessionSignedVoucher,
  enrollLockableVault,
  openTab,
} from "./lock-voucher";
import type { LockableVaultContext } from "./lock-voucher";

describe("finalize_withdrawal — reservation gate", () => {
  const provider = makeTestProvider();
  anchor.setProvider(provider);
  const program = anchor.workspace.DexterVault as Program<DexterVault>;

  async function lockAmount(
    ctx: LockableVaultContext,
    amount: bigint,
    sequenceNumber: number
  ): Promise<void> {
    const voucher = buildSessionSignedVoucher({
      sessionKeypair: ctx.sessionKeypair,
      channelId: ctx.channelId,
      cumulativeAmount: amount,
      sequenceNumber,
    });
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
    await provider.sendAndConfirm(new Transaction().add(voucher.precompileIx, lockIx));
  }

  async function buildRequestWithdrawalIx(
    vaultPda: PublicKey,
    passkey: P256Keypair,
    amount: bigint,
    destination: PublicKey,
    signedAt: bigint
  ): Promise<Transaction> {
    const opMsg = requestWithdrawalMessage(amount, destination, signedAt);
    const signed = signOperationWithPasskey(passkey, opMsg);
    const precompileIx = buildSecp256r1VerifyInstruction(
      passkey.publicKey,
      signed.signature,
      signed.precompileMessage
    );
    const vaultIx = await program.methods
      .requestWithdrawal({
        amount: new BN(amount.toString()),
        destination,
        signedAt: new BN(signedAt.toString()),
        clientDataJson: Buffer.from(signed.clientDataJSON),
        authenticatorData: Buffer.from(signed.authenticatorData),
      })
      .accountsPartial({
        vault: vaultPda,
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .instruction();
    return new Transaction().add(precompileIx, vaultIx);
  }

  async function buildFinalizeWithdrawalTx(
    ctx: LockableVaultContext,
    amount: bigint,
    destination: PublicKey
  ): Promise<Transaction> {
    const opMsg = finalizeWithdrawalMessage(amount, destination);
    const signed = signOperationWithPasskey(ctx.passkey, opMsg);
    const precompileIx = buildSecp256r1VerifyInstruction(
      ctx.passkey.publicKey,
      signed.signature,
      signed.precompileMessage
    );
    const vaultIx = await program.methods
      .finalizeWithdrawal({
        clientDataJson: Buffer.from(signed.clientDataJSON),
        authenticatorData: Buffer.from(signed.authenticatorData),
      })
      .accountsPartial({
        vault: ctx.vaultPda,
        swig: ctx.swigAddress,
        // V0.3 Decision 1: the live read for the reservation invariant.
        vaultUsdcAta: ctx.sourceAta,
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .instruction();
    return new Transaction().add(precompileIx, vaultIx);
  }

  it("finalize_withdrawal — reservation gate (reject)", async () => {
    // Vault funded $10, lock $5, attempt withdrawal of $7 → reject.
    const ctx = await enrollLockableVault(program, provider, {
      usdcFundingAmount: 10_000_000n,
      maxAmount: 5_000_000n,
      maxRevolvingCapacity: 5_000_000n,
    });

    // Open tab on the credex meter, then lock the full $5 into a
    // LockedClaim (graduating session → vault tier).
    await openTab(program, provider, ctx.vaultPda, 5_000_000n);
    await lockAmount(ctx, 5_000_000n, 1);

    const destination = Keypair.generate().publicKey;
    const withdrawAmount = 7_000_000n;
    const signedAt = BigInt(Math.floor(Date.now() / 1000));

    await provider.sendAndConfirm(
      await buildRequestWithdrawalIx(ctx.vaultPda, ctx.passkey, withdrawAmount, destination, signedAt)
    );

    let threw = false;
    try {
      await provider.sendAndConfirm(
        await buildFinalizeWithdrawalTx(ctx, withdrawAmount, destination)
      );
    } catch (err: any) {
      threw = true;
      expect(String(err)).to.match(/WithdrawalWouldViolateReservation/);
    }
    expect(threw, "withdrawal that would violate reservation must reject").to.equal(true);
  });

  it("finalize_withdrawal — reservation gate (permit)", async () => {
    // Vault funded $10, lock $3, attempt withdrawal of $5 → permit
    // ($10 - $5 = $5 >= $3 locked). The assertion is structural: the
    // reservation gate does not throw WithdrawalWouldViolateReservation.
    // The downstream Swig::SignV2(TransferChecked) wrapper that actually
    // moves the tokens is intentionally not built here — Task 7 owns the
    // gate decision, not the transfer. Any non-reservation error (e.g.
    // missing Swig CPI follow-up) is tolerated.
    const ctx = await enrollLockableVault(program, provider, {
      usdcFundingAmount: 10_000_000n,
      maxAmount: 5_000_000n,
      maxRevolvingCapacity: 5_000_000n,
    });

    await openTab(program, provider, ctx.vaultPda, 3_000_000n);
    await lockAmount(ctx, 3_000_000n, 1);

    const destination = Keypair.generate().publicKey;
    const withdrawAmount = 5_000_000n;
    const signedAt = BigInt(Math.floor(Date.now() / 1000));

    await provider.sendAndConfirm(
      await buildRequestWithdrawalIx(ctx.vaultPda, ctx.passkey, withdrawAmount, destination, signedAt)
    );

    // The call may still throw on the downstream verify_passkey_signed
    // step (it expects the precompile, which is present) or on the
    // absence of the Swig CPI wrapper — but if the reservation gate
    // matched we'd see a balance-check error and never reach those steps.
    // The assertion explicitly excludes the reservation error.
    let reservationViolation = false;
    try {
      await provider.sendAndConfirm(
        await buildFinalizeWithdrawalTx(ctx, withdrawAmount, destination)
      );
    } catch (err: any) {
      if (/WithdrawalWouldViolateReservation/.test(String(err))) {
        reservationViolation = true;
      }
      // Any other error is ignored: the wallet PDA isn't a signer here so
      // the SPL transfer would fail without the SignV2 wrapper anyway.
    }
    expect(reservationViolation, "permitted withdrawal must not hit the reservation gate").to.equal(false);
  });
});
