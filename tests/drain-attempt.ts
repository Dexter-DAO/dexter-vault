import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import { DexterVault } from "../target/types/dexter_vault";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { expect } from "chai";

import {
  generateP256Keypair,
  signMessage,
  buildSecp256r1VerifyInstruction,
  requestWithdrawalMessage,
  finalizeWithdrawalMessage,
  setSwigMessage,
} from "./helpers/secp256r1";

/**
 * The adversarial drain-attempt test. This is the kill-move proof on chain:
 *
 *   1. User opens streaming session — Dexter session role registers a
 *      pending voucher, vault.pending_voucher_count = 1.
 *   2. User mid-session decides to be hostile and tries to pull the funds
 *      back to themselves before the seller has been settled.
 *   3. User passkey signs request_withdrawal + finalize_withdrawal — both
 *      cryptographically valid.
 *   4. finalize_withdrawal IS REJECTED ON CHAIN by PendingVouchersExist.
 *      The vault refuses to release funds while the seller is owed.
 *   5. Dexter settles the voucher (decrement). pending_voucher_count = 0.
 *   6. User passkey signs finalize_withdrawal again — now it succeeds.
 *
 * That's the entire "Flex is escrow per seller, we're one vault per user"
 * story, demonstrated by the chain itself in a single test.
 */
describe("drain-attempt (adversarial)", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.DexterVault as Program<DexterVault>;

  it("vault rejects mid-session drain, accepts post-settlement drain", async () => {
    // ── Setup vault with cooling-off=0 so the test is fast. The cooling-off
    // gate is independently tested in withdrawal-flow.ts. This test isolates
    // the pending-voucher veto specifically.
    const supabaseUserId = new Uint8Array(16);
    crypto.getRandomValues(supabaseUserId);
    const { privateKey, publicKey } = generateP256Keypair();
    const [vaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), Buffer.from(supabaseUserId)],
      program.programId
    );

    await program.methods
      .initializeVault({
        passkeyPubkey: Array.from(publicKey),
        coolingOffSeconds: new BN(0),
        supabaseUserId: Array.from(supabaseUserId),
      })
      .accounts({
        vault: vaultPda,
        payer: provider.wallet.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    // Bind a Swig so finalize is callable.
    const swigAddress = Keypair.generate().publicKey;
    {
      const message = setSwigMessage(swigAddress);
      const sig = signMessage(privateKey, message);
      const precompileIx = buildSecp256r1VerifyInstruction(publicKey, sig, message);
      const vaultIx = await program.methods
        .setSwig({ swigAddress })
        .accounts({
          vault: vaultPda,
          instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        })
        .instruction();
      const tx = new Transaction().add(precompileIx, vaultIx);
      await sendAndConfirmTransaction(provider.connection, tx, [
        (provider.wallet as anchor.Wallet).payer,
      ]);
    }

    // ── 1. Open a streaming session. Dexter signs a voucher; vault count=1.
    await program.methods
      .settleVoucher({ amount: new BN(2_000), increment: true })
      .accounts({
        vault: vaultPda,
        dexterSessionSigner: provider.wallet.publicKey,
      })
      .rpc();

    {
      const v = await program.account.vault.fetch(vaultPda);
      expect(v.pendingVoucherCount).to.equal(1);
    }

    // ── 2-3. User passkey signs a request_withdrawal mid-session.
    const destination = Keypair.generate().publicKey;
    const drainAmount = BigInt(5_000_000);
    const signedAt = BigInt(Math.floor(Date.now() / 1000));

    {
      const reqMsg = requestWithdrawalMessage(drainAmount, destination, signedAt);
      const reqSig = signMessage(privateKey, reqMsg);
      const reqPrecompileIx = buildSecp256r1VerifyInstruction(publicKey, reqSig, reqMsg);
      const reqVaultIx = await program.methods
        .requestWithdrawal({
          amount: new BN(drainAmount.toString()),
          destination,
          signedAt: new BN(signedAt.toString()),
        })
        .accounts({
          vault: vaultPda,
          instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        })
        .instruction();
      const reqTx = new Transaction().add(reqPrecompileIx, reqVaultIx);
      await sendAndConfirmTransaction(provider.connection, reqTx, [
        (provider.wallet as anchor.Wallet).payer,
      ]);
    }

    // ── 4. User immediately tries to finalize. The chain says no.
    {
      const finMsg = finalizeWithdrawalMessage(drainAmount, destination);
      const finSig = signMessage(privateKey, finMsg);
      const finPrecompileIx = buildSecp256r1VerifyInstruction(publicKey, finSig, finMsg);
      const finVaultIx = await program.methods
        .finalizeWithdrawal()
        .accounts({
          vault: vaultPda,
          swig: swigAddress,
          instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        })
        .instruction();
      const finTx = new Transaction().add(finPrecompileIx, finVaultIx);

      let threw = false;
      try {
        await sendAndConfirmTransaction(provider.connection, finTx, [
          (provider.wallet as anchor.Wallet).payer,
        ]);
      } catch (err: any) {
        threw = true;
        expect(String(err)).to.match(/PendingVouchersExist/);
      }
      expect(threw, "drain mid-session must be rejected").to.equal(true);
    }

    // Vault state is unchanged: pending withdrawal still recorded, voucher
    // still pending. The drain attempt left no trace beyond the rejected tx.
    {
      const v = await program.account.vault.fetch(vaultPda);
      expect(v.pendingVoucherCount).to.equal(1);
      expect(v.pendingWithdrawal).to.not.be.null;
    }

    // ── 5. Dexter settles the voucher (decrement). count=0.
    await program.methods
      .settleVoucher({ amount: new BN(2_000), increment: false })
      .accounts({
        vault: vaultPda,
        dexterSessionSigner: provider.wallet.publicKey,
      })
      .rpc();

    {
      const v = await program.account.vault.fetch(vaultPda);
      expect(v.pendingVoucherCount).to.equal(0);
    }

    // ── 6. User retries finalize. Now it succeeds.
    {
      const finMsg = finalizeWithdrawalMessage(drainAmount, destination);
      const finSig = signMessage(privateKey, finMsg);
      const finPrecompileIx = buildSecp256r1VerifyInstruction(publicKey, finSig, finMsg);
      const finVaultIx = await program.methods
        .finalizeWithdrawal()
        .accounts({
          vault: vaultPda,
          swig: swigAddress,
          instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        })
        .instruction();
      const finTx = new Transaction().add(finPrecompileIx, finVaultIx);
      await sendAndConfirmTransaction(provider.connection, finTx, [
        (provider.wallet as anchor.Wallet).payer,
      ]);
    }

    const finalState = await program.account.vault.fetch(vaultPda);
    expect(finalState.pendingWithdrawal).to.be.null;
    expect(finalState.pendingVoucherCount).to.equal(0);
  });
});
