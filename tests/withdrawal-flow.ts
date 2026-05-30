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
  pollUntilAccount,
} from "./helpers/secp256r1";

describe("withdrawal flow (request → cooling-off → finalize)", () => {
  const provider = makeTestProvider();
  const program = anchor.workspace.DexterVault as Program<DexterVault>;

  async function provisionVault(coolingOffSeconds: number) {
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
        coolingOffSeconds,
        identityClaim: Array.from(identityClaim),
      })
      .accounts({
        vault: vaultPda,
        payer: provider.wallet.publicKey,
        dexterAuthority: provider.wallet.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    return { vaultPda, keypair };
  }

  async function bindSwig(vaultPda: PublicKey, keypair: P256Keypair): Promise<PublicKey> {
    const swigAddress = Keypair.generate().publicKey;
    const opMsg = setSwigMessage(swigAddress);
    const signed = signOperationWithPasskey(keypair, opMsg);
    const precompileIx = buildSecp256r1VerifyInstruction(keypair.publicKey, signed.signature, signed.precompileMessage);
    const vaultIx = await program.methods
      .setSwig({
        swigAddress,
        clientDataJson: Buffer.from(signed.clientDataJSON),
        authenticatorData: Buffer.from(signed.authenticatorData),
      })
      .accounts({
        vault: vaultPda,
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .instruction();
    const tx = new Transaction().add(precompileIx, vaultIx);
    await sendAndConfirmTransaction(provider.connection, tx, [
      (provider.wallet as anchor.Wallet).payer,
    ]);
    return swigAddress;
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
      .accounts({
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
      .accounts({
        vault: vaultPda,
        swig: swigAddress,
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .instruction();
    return new Transaction().add(precompileIx, vaultIx);
  }

  it("request_withdrawal records pending state with passkey signature", async () => {
    const { vaultPda, keypair } = await provisionVault(86400);
    const destination = Keypair.generate().publicKey;
    const amount = BigInt(2_500_000);
    const signedAt = BigInt(Math.floor(Date.now() / 1000));

    await sendAndConfirmTransaction(
      provider.connection,
      await buildRequestTx(vaultPda, keypair, amount, destination, signedAt),
      [(provider.wallet as anchor.Wallet).payer]
    );

    const vault = await program.account.vault.fetch(vaultPda);
    expect(vault.pendingWithdrawal).to.not.be.null;
    expect(vault.pendingWithdrawal!.amount.toString()).to.equal(amount.toString());
    expect(vault.pendingWithdrawal!.destination.toBase58()).to.equal(destination.toBase58());
    expect(vault.pendingWithdrawal!.requestedAt.toString()).to.equal(signedAt.toString());
  });

  it("finalize_withdrawal fails when cooling-off has not elapsed", async () => {
    const { vaultPda, keypair } = await provisionVault(86400);
    const swigAddress = await bindSwig(vaultPda, keypair);
    const destination = Keypair.generate().publicKey;
    const amount = BigInt(1_000_000);
    const signedAt = BigInt(Math.floor(Date.now() / 1000));

    await sendAndConfirmTransaction(
      provider.connection,
      await buildRequestTx(vaultPda, keypair, amount, destination, signedAt),
      [(provider.wallet as anchor.Wallet).payer]
    );

    let threw = false;
    try {
      await sendAndConfirmTransaction(
        provider.connection,
        await buildFinalizeTx(vaultPda, keypair, amount, destination, swigAddress),
        [(provider.wallet as anchor.Wallet).payer]
      );
    } catch (err: any) {
      threw = true;
      expect(String(err)).to.match(/CoolingOffNotElapsed/);
    }
    expect(threw).to.equal(true);
  });

  it("finalize_withdrawal fails when pending vouchers exist", async () => {
    const { vaultPda, keypair } = await provisionVault(0);
    const swigAddress = await bindSwig(vaultPda, keypair);
    const destination = Keypair.generate().publicKey;
    const amount = BigInt(1_500_000);
    const signedAt = BigInt(Math.floor(Date.now() / 1000));

    await sendAndConfirmTransaction(
      provider.connection,
      await buildRequestTx(vaultPda, keypair, amount, destination, signedAt),
      [(provider.wallet as anchor.Wallet).payer]
    );

    await program.methods
      .settleVoucher({ amount: new BN(500), increment: true })
      .accounts({
        vault: vaultPda,
        dexterAuthority: provider.wallet.publicKey,
      })
      .rpc();

    let threw = false;
    try {
      await sendAndConfirmTransaction(
        provider.connection,
        await buildFinalizeTx(vaultPda, keypair, amount, destination, swigAddress),
        [(provider.wallet as anchor.Wallet).payer]
      );
    } catch (err: any) {
      threw = true;
      expect(String(err)).to.match(/PendingVouchersExist/);
    }
    expect(threw).to.equal(true);
  });

  it("finalize_withdrawal succeeds when cooling-off elapsed and no pending vouchers", async () => {
    const { vaultPda, keypair } = await provisionVault(0);
    const swigAddress = await bindSwig(vaultPda, keypair);
    const destination = Keypair.generate().publicKey;
    const amount = BigInt(750_000);
    const signedAt = BigInt(Math.floor(Date.now() / 1000));

    await sendAndConfirmTransaction(
      provider.connection,
      await buildRequestTx(vaultPda, keypair, amount, destination, signedAt),
      [(provider.wallet as anchor.Wallet).payer]
    );

    await sendAndConfirmTransaction(
      provider.connection,
      await buildFinalizeTx(vaultPda, keypair, amount, destination, swigAddress),
      [(provider.wallet as anchor.Wallet).payer]
    );

    // Read replicas can lag behind even a finalized confirmation by 1-2s.
    // Poll the fetch until the pending_withdrawal clear propagates.
    const vault = await pollUntilAccount(
      () => program.account.vault.fetch(vaultPda),
      (v) => v.pendingWithdrawal === null,
    );
    expect(vault.pendingWithdrawal).to.be.null;
  });

  it("finalize_withdrawal fails when swig not bound", async () => {
    const { vaultPda, keypair } = await provisionVault(0);
    const fakeSwig = Keypair.generate().publicKey;
    const destination = Keypair.generate().publicKey;
    const amount = BigInt(100_000);
    const signedAt = BigInt(Math.floor(Date.now() / 1000));

    await sendAndConfirmTransaction(
      provider.connection,
      await buildRequestTx(vaultPda, keypair, amount, destination, signedAt),
      [(provider.wallet as anchor.Wallet).payer]
    );

    let threw = false;
    try {
      await sendAndConfirmTransaction(
        provider.connection,
        await buildFinalizeTx(vaultPda, keypair, amount, destination, fakeSwig),
        [(provider.wallet as anchor.Wallet).payer]
      );
    } catch (err: any) {
      threw = true;
      expect(String(err)).to.match(/NoPendingWithdrawal|PasskeyVerificationFailed/);
    }
    expect(threw).to.equal(true);
  });
});
