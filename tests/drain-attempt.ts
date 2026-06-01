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
  signOperationWithPasskey,
  buildSecp256r1VerifyInstruction,
  requestWithdrawalMessage,
  finalizeWithdrawalMessage,
  setSwigMessage,
  P256Keypair,
  makeTestProvider,
} from "./helpers/secp256r1";

/**
 * Drain-attempt adversarial test — the kill move on chain.
 *
 *   1. Open streaming session (Dexter increments pending_voucher_count)
 *   2. User passkey signs request_withdrawal mid-session
 *   3. User passkey signs finalize_withdrawal — REJECTED with PendingVouchersExist
 *   4. State unchanged: voucher still pending, withdrawal still queued
 *   5. Dexter decrements voucher (settles seller)
 *   6. User passkey signs finalize again — succeeds
 */
describe("drain-attempt (adversarial)", () => {
  const provider = makeTestProvider();
  const program = anchor.workspace.DexterVault as Program<DexterVault>;

  async function buildSetSwigTx(
    vaultPda: PublicKey,
    keypair: P256Keypair,
    swigAddress: PublicKey
  ): Promise<Transaction> {
    const opMsg = setSwigMessage(swigAddress);
    const signed = signOperationWithPasskey(keypair, opMsg);
    const precompileIx = buildSecp256r1VerifyInstruction(keypair.publicKey, signed.signature, signed.precompileMessage);
    const vaultIx = await program.methods
      .setSwig({
        swigAddress,
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

  async function buildRequestTx(
    vaultPda: PublicKey,
    keypair: P256Keypair,
    amount: bigint,
    destination: PublicKey,
    signedAt: bigint
  ): Promise<Transaction> {
    const opMsg = requestWithdrawalMessage(amount, destination, signedAt);
    const signed = signOperationWithPasskey(keypair, opMsg);
    const precompileIx = buildSecp256r1VerifyInstruction(keypair.publicKey, signed.signature, signed.precompileMessage);
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

  async function buildFinalizeTx(
    vaultPda: PublicKey,
    keypair: P256Keypair,
    amount: bigint,
    destination: PublicKey,
    swigAddress: PublicKey
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
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .instruction();
    return new Transaction().add(precompileIx, vaultIx);
  }

  it("vault rejects mid-session drain, accepts post-settlement drain", async () => {
    const identityClaim = new Uint8Array(32);
    crypto.getRandomValues(identityClaim);
    const keypair = generateP256Keypair();
    const [vaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), Buffer.from(identityClaim.slice(0, 16))],
      program.programId
    );

    await program.methods
      .initializeVault({
        passkeyPubkey: Array.from(keypair.publicKey),
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

    const swigAddress = Keypair.generate().publicKey;
    await sendAndConfirmTransaction(
      provider.connection,
      await buildSetSwigTx(vaultPda, keypair, swigAddress),
      [(provider.wallet as anchor.Wallet).payer]
    );

    // 1. Open streaming session — pending_voucher_count = 1.
    await program.methods
      .settleVoucher({ amount: new BN(2_000), increment: true })
      .accountsPartial({
        vault: vaultPda,
        dexterAuthority: provider.wallet.publicKey,
      })
      .rpc();
    {
      const v = await program.account.vault.fetch(vaultPda);
      expect(v.pendingVoucherCount).to.equal(1);
    }

    // 2-3. User passkey signs request, then finalize — finalize REJECTS.
    const destination = Keypair.generate().publicKey;
    const drainAmount = BigInt(5_000_000);
    const signedAt = BigInt(Math.floor(Date.now() / 1000));

    await sendAndConfirmTransaction(
      provider.connection,
      await buildRequestTx(vaultPda, keypair, drainAmount, destination, signedAt),
      [(provider.wallet as anchor.Wallet).payer]
    );

    let threw = false;
    try {
      await sendAndConfirmTransaction(
        provider.connection,
        await buildFinalizeTx(vaultPda, keypair, drainAmount, destination, swigAddress),
        [(provider.wallet as anchor.Wallet).payer]
      );
    } catch (err: any) {
      threw = true;
      expect(String(err)).to.match(/PendingVouchersExist/);
    }
    expect(threw, "drain mid-session must be rejected").to.equal(true);

    // 4. State unchanged.
    {
      const v = await program.account.vault.fetch(vaultPda);
      expect(v.pendingVoucherCount).to.equal(1);
      expect(v.pendingWithdrawal).to.not.be.null;
    }

    // 5. Dexter settles. Voucher count → 0.
    await program.methods
      .settleVoucher({ amount: new BN(2_000), increment: false })
      .accountsPartial({
        vault: vaultPda,
        dexterAuthority: provider.wallet.publicKey,
      })
      .rpc();
    {
      const v = await program.account.vault.fetch(vaultPda);
      expect(v.pendingVoucherCount).to.equal(0);
    }

    // 6. Finalize succeeds.
    await sendAndConfirmTransaction(
      provider.connection,
      await buildFinalizeTx(vaultPda, keypair, drainAmount, destination, swigAddress),
      [(provider.wallet as anchor.Wallet).payer]
    );

    const finalState = await program.account.vault.fetch(vaultPda);
    expect(finalState.pendingWithdrawal).to.be.null;
    expect(finalState.pendingVoucherCount).to.equal(0);
  });
});
