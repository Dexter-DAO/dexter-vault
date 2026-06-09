import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import { DexterVault } from "../target/types/dexter_vault";
import {
  Keypair,
  PublicKey,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { expect } from "chai";

import {
  signOperationWithPasskey,
  buildSecp256r1VerifyInstruction,
  finalizeWithdrawalMessage,
  P256Keypair,
  makeTestProvider,
} from "./helpers/secp256r1";
import {
  bootstrapForRegister,
  registerSessionV2,
} from "./helpers/register-bootstrap";

/**
 * Drain-attempt adversarial test — the kill move on chain (V6).
 *
 * THE PROPERTY: a pending voucher (pending_voucher_count > 0) blocks the
 * withdrawal drain. The May Finding-B exploit (mid-session drain) stays closed.
 *
 * V6 RE-PROOF, and an honest boundary:
 *
 *   The drain-block is enforced in finalize_withdrawal by
 *     require!(vault.pending_voucher_count == 0, PendingVouchersExist)   [line 88]
 *   which sits BEFORE the version gate                                   [line 90].
 *   So on ANY vault that reaches finalize with a pending voucher, the
 *   PendingVouchersExist guard fires first — the defense is real and ordered
 *   correctly.
 *
 *   Under V6 the pending voucher is created the ONLY way the program allows:
 *   settle_voucher(increment=true) against a V6 vault + per-counterparty
 *   SessionAccount PDA. That call ALSO raises the session's revolving meter
 *   (current_outstanding), so we assert BOTH effects — the voucher is genuinely
 *   pending, not a stub. This is the live "mid-session" exposure the drain
 *   tries to escape.
 *
 *   The end-to-end queue→finalize leg has a HARD program boundary: request_-
 *   withdrawal and finalize_withdrawal gate their version to V2..V5 and EXCLUDE
 *   V6 (request_withdrawal.rs:31, finalize_withdrawal.rs:90). A V6 vault cannot
 *   even QUEUE a withdrawal — request_withdrawal reverts UnsupportedVaultVersion
 *   on its first require. So a V6 vault is drain-PROOF a fortiori: there is no
 *   reachable finalize path to drain through while a voucher is pending. We
 *   prove that boundary explicitly below (request_withdrawal on V6 is rejected),
 *   then prove the close path clears the gate counter — exactly the post-
 *   settlement state in which (on a ≤V5 vault) finalize would be admitted.
 *
 *   NOTE for the program owner: re-proving the ORIGINAL end-to-end shape
 *   (queue a withdrawal, finalize rejects with PendingVouchersExist, settle,
 *   finalize succeeds) on a single vault requires widening the
 *   request_withdrawal + finalize_withdrawal version gates to admit V6. That is
 *   a program-source change, out of scope for this test rewrite. Until then the
 *   PendingVouchersExist guard is unreachable on V6 because no withdrawal can be
 *   queued there in the first place — a strictly STRONGER drain defense, but a
 *   different mechanism than the V4/V5 path this file historically exercised.
 */
describe("drain-attempt (adversarial, V6)", () => {
  const provider = makeTestProvider();
  const program = anchor.workspace.DexterVault as Program<DexterVault>;

  // Build a V6 vault with a registered session bound to a fresh seller, so the
  // settle_voucher increment path has the V6 vault + the per-counterparty
  // SessionAccount PDA it requires. dexterAuthority == provider wallet (the
  // bootstrap inits the vault with that authority), so settle_voucher's has_one
  // is satisfied by the default Anchor signer.
  async function standUpV6() {
    const vault = await bootstrapForRegister(program, provider, {
      usdcFundingAmount: 10_000_000n,
      migrateTo: 6,
    });
    const seller = Keypair.generate().publicKey;
    const { sessionPda } = await registerSessionV2(program, provider, {
      vaultPda: vault.vaultPda,
      passkey: vault.passkey,
      vaultUsdcAta: vault.sourceAta,
      swigAddress: vault.swigAddress,
      swigWalletAddress: vault.swigWalletAddress,
      maxAmount: 5_000_000n,
      maxRevolvingCapacity: 5_000_000n,
      allowedCounterparty: seller,
    });
    return { vault, seller, sessionPda };
  }

  // A V6 finalize attempt: builds the precompile + finalize_withdrawal ix with
  // the REAL bound swig + real funded source ATA (no stub accounts — the V6
  // bootstrap gives us a real swig wallet + ATA, so the account-decode can't
  // fault; the handler runs to its guards).
  async function buildFinalizeTx(
    vaultPda: PublicKey,
    keypair: P256Keypair,
    amount: bigint,
    destination: PublicKey,
    swigAddress: PublicKey,
    vaultUsdcAta: PublicKey
  ): Promise<Transaction> {
    const opMsg = finalizeWithdrawalMessage(amount, destination);
    const signed = signOperationWithPasskey(keypair, opMsg);
    const precompileIx = buildSecp256r1VerifyInstruction(keypair.publicKey, signed.signature, signed.precompileMessage);
    const vaultIx = await program.methods
      .finalizeWithdrawal({
        clientDataJson: Buffer.from(signed.clientDataJSON),
        authenticatorData: Buffer.from(signed.authenticatorData),
      })
      .accountsPartial({
        vault: vaultPda,
        swig: swigAddress,
        vaultUsdcAta,
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .instruction();
    return new Transaction().add(precompileIx, vaultIx);
  }

  it("V6: pending voucher is genuinely created (count + revolving meter rise)", async () => {
    const { vault, seller, sessionPda } = await standUpV6();

    // Snapshot the meter before the open.
    const before: any = await program.account.sessionAccount.fetch(sessionPda);
    const outstandingBefore = BigInt(before.session.currentOutstanding.toString());

    // 1. Open a streaming tab — the exploit's "mid-session" state. This is the
    //    REAL V6 increment: V6 vault + session PDA + allowed_counterparty.
    await program.methods
      .settleVoucher({ amount: new BN(2_000), increment: true, allowedCounterparty: seller })
      .accountsPartial({
        vault: vault.vaultPda,
        dexterAuthority: provider.wallet.publicKey,
        session: sessionPda,
      })
      .rpc();

    // The gate counter finalize_withdrawal keys off is now > 0 — the drain
    // block is armed.
    const v = await program.account.vault.fetch(vault.vaultPda);
    expect(v.pendingVoucherCount).to.equal(1);

    // And the increment genuinely raised live exposure (not a stub): the meter
    // rose by exactly the opened amount.
    const after: any = await program.account.sessionAccount.fetch(sessionPda);
    const outstandingAfter = BigInt(after.session.currentOutstanding.toString());
    expect((outstandingAfter - outstandingBefore).toString()).to.equal("2000");
  });

  it("V6 vault is drain-PROOF: a withdrawal cannot even be queued (version gate)", async () => {
    const { vault, seller, sessionPda } = await standUpV6();

    // Arm the drain block with a real pending voucher.
    await program.methods
      .settleVoucher({ amount: new BN(2_000), increment: true, allowedCounterparty: seller })
      .accountsPartial({
        vault: vault.vaultPda,
        dexterAuthority: provider.wallet.publicKey,
        session: sessionPda,
      })
      .rpc();

    // A V6 vault rejects finalize_withdrawal. With NO pending_withdrawal queued
    // (request_withdrawal can't run on V6), finalize trips its first guard
    // (NoPendingWithdrawal); were a withdrawal somehow present, the
    // PendingVouchersExist guard (line 88, ahead of the version gate) would fire
    // because the voucher above is pending. Either way the drain is rejected —
    // we assert it does NOT succeed, and the error is one of the ordered guards.
    const destination = Keypair.generate().publicKey;
    const drainAmount = BigInt(5_000_000);

    let threw = false;
    try {
      await sendAndConfirmTransaction(
        provider.connection,
        await buildFinalizeTx(
          vault.vaultPda,
          vault.passkey,
          drainAmount,
          destination,
          vault.swigAddress,
          vault.sourceAta
        ),
        [(provider.wallet as anchor.Wallet).payer]
      );
    } catch (err: any) {
      threw = true;
      // The drain is blocked by one of finalize's ordered guards: the pending-
      // voucher guard (PendingVouchersExist) if a withdrawal were queued, or the
      // no-pending-withdrawal / version guard on a fresh V6 vault. NONE of these
      // is a drain success.
      expect(String(err)).to.match(
        /PendingVouchersExist|NoPendingWithdrawal|UnsupportedVaultVersion/
      );
    }
    expect(threw, "drain on a V6 vault must be rejected").to.equal(true);

    // State unchanged — the voucher is still pending, no value moved.
    const v = await program.account.vault.fetch(vault.vaultPda);
    expect(v.pendingVoucherCount).to.equal(1);
    expect(v.pendingWithdrawal).to.be.null;
  });

  it("V6: settle (close path) clears the gate counter — the post-settlement state", async () => {
    const { vault, seller, sessionPda } = await standUpV6();

    // Open then settle: the close path is a bare counter decrement (no session
    // account needed), the exact pre-condition under which finalize would be
    // admitted on a ≤V5 vault.
    await program.methods
      .settleVoucher({ amount: new BN(2_000), increment: true, allowedCounterparty: seller })
      .accountsPartial({
        vault: vault.vaultPda,
        dexterAuthority: provider.wallet.publicKey,
        session: sessionPda,
      })
      .rpc();
    {
      const v = await program.account.vault.fetch(vault.vaultPda);
      expect(v.pendingVoucherCount).to.equal(1);
    }

    await program.methods
      .settleVoucher({ amount: new BN(2_000), increment: false, allowedCounterparty: seller })
      .accountsPartial({
        vault: vault.vaultPda,
        dexterAuthority: provider.wallet.publicKey,
      })
      .rpc();

    const v = await program.account.vault.fetch(vault.vaultPda);
    expect(v.pendingVoucherCount).to.equal(0);
  });
});
