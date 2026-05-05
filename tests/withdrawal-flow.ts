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

describe("withdrawal flow (request → cooling-off → finalize)", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.DexterVault as Program<DexterVault>;

  async function provisionVault(coolingOffSeconds: number) {
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
        coolingOffSeconds: new BN(coolingOffSeconds),
        supabaseUserId: Array.from(supabaseUserId),
      })
      .accounts({
        vault: vaultPda,
        payer: provider.wallet.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    return { vaultPda, privateKey, publicKey };
  }

  async function bindSwig(
    vaultPda: PublicKey,
    privateKey: Uint8Array,
    publicKey: Uint8Array
  ): Promise<PublicKey> {
    const swigAddress = Keypair.generate().publicKey;
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
    return swigAddress;
  }

  async function buildRequestWithdrawalTx(
    vaultPda: PublicKey,
    privateKey: Uint8Array,
    publicKey: Uint8Array,
    amount: bigint,
    destination: PublicKey,
    signedAt: bigint
  ): Promise<Transaction> {
    const message = requestWithdrawalMessage(amount, destination, signedAt);
    const sig = signMessage(privateKey, message);
    const precompileIx = buildSecp256r1VerifyInstruction(publicKey, sig, message);
    const vaultIx = await program.methods
      .requestWithdrawal({
        amount: new BN(amount.toString()),
        destination,
        signedAt: new BN(signedAt.toString()),
      })
      .accounts({
        vault: vaultPda,
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .instruction();
    const tx = new Transaction().add(precompileIx, vaultIx);
    return tx;
  }

  async function buildFinalizeWithdrawalTx(
    vaultPda: PublicKey,
    privateKey: Uint8Array,
    publicKey: Uint8Array,
    amount: bigint,
    destination: PublicKey,
    swigAddress: PublicKey
  ): Promise<Transaction> {
    const message = finalizeWithdrawalMessage(amount, destination);
    const sig = signMessage(privateKey, message);
    const precompileIx = buildSecp256r1VerifyInstruction(publicKey, sig, message);
    const vaultIx = await program.methods
      .finalizeWithdrawal()
      .accounts({
        vault: vaultPda,
        swig: swigAddress,
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .instruction();
    const tx = new Transaction().add(precompileIx, vaultIx);
    return tx;
  }

  it("request_withdrawal records pending state with passkey signature", async () => {
    const { vaultPda, privateKey, publicKey } = await provisionVault(86400);
    const destination = Keypair.generate().publicKey;
    const amount = BigInt(2_500_000);
    const signedAt = BigInt(Math.floor(Date.now() / 1000));

    const tx = await buildRequestWithdrawalTx(
      vaultPda,
      privateKey,
      publicKey,
      amount,
      destination,
      signedAt
    );
    await sendAndConfirmTransaction(provider.connection, tx, [
      (provider.wallet as anchor.Wallet).payer,
    ]);

    const vault = await program.account.vault.fetch(vaultPda);
    expect(vault.pendingWithdrawal).to.not.be.null;
    expect(vault.pendingWithdrawal!.amount.toString()).to.equal(amount.toString());
    expect(vault.pendingWithdrawal!.destination.toBase58()).to.equal(destination.toBase58());
    expect(vault.pendingWithdrawal!.requestedAt.toString()).to.equal(signedAt.toString());
  });

  it("finalize_withdrawal fails when cooling-off has not elapsed", async () => {
    const { vaultPda, privateKey, publicKey } = await provisionVault(86400);
    const swigAddress = await bindSwig(vaultPda, privateKey, publicKey);
    const destination = Keypair.generate().publicKey;
    const amount = BigInt(1_000_000);
    const signedAt = BigInt(Math.floor(Date.now() / 1000));

    const requestTx = await buildRequestWithdrawalTx(
      vaultPda,
      privateKey,
      publicKey,
      amount,
      destination,
      signedAt
    );
    await sendAndConfirmTransaction(provider.connection, requestTx, [
      (provider.wallet as anchor.Wallet).payer,
    ]);

    const finalizeTx = await buildFinalizeWithdrawalTx(
      vaultPda,
      privateKey,
      publicKey,
      amount,
      destination,
      swigAddress
    );

    let threw = false;
    try {
      await sendAndConfirmTransaction(provider.connection, finalizeTx, [
        (provider.wallet as anchor.Wallet).payer,
      ]);
    } catch (err: any) {
      threw = true;
      expect(String(err)).to.match(/CoolingOffNotElapsed/);
    }
    expect(threw).to.equal(true);
  });

  it("finalize_withdrawal fails when pending vouchers exist", async () => {
    const { vaultPda, privateKey, publicKey } = await provisionVault(0);
    const swigAddress = await bindSwig(vaultPda, privateKey, publicKey);
    const destination = Keypair.generate().publicKey;
    const amount = BigInt(1_500_000);
    const signedAt = BigInt(Math.floor(Date.now() / 1000));

    const requestTx = await buildRequestWithdrawalTx(
      vaultPda,
      privateKey,
      publicKey,
      amount,
      destination,
      signedAt
    );
    await sendAndConfirmTransaction(provider.connection, requestTx, [
      (provider.wallet as anchor.Wallet).payer,
    ]);

    await program.methods
      .settleVoucher({ amount: new BN(500), increment: true })
      .accounts({
        vault: vaultPda,
        dexterSessionSigner: provider.wallet.publicKey,
      })
      .rpc();

    const finalizeTx = await buildFinalizeWithdrawalTx(
      vaultPda,
      privateKey,
      publicKey,
      amount,
      destination,
      swigAddress
    );
    let threw = false;
    try {
      await sendAndConfirmTransaction(provider.connection, finalizeTx, [
        (provider.wallet as anchor.Wallet).payer,
      ]);
    } catch (err: any) {
      threw = true;
      expect(String(err)).to.match(/PendingVouchersExist/);
    }
    expect(threw).to.equal(true);
  });

  it("finalize_withdrawal succeeds when cooling-off elapsed and no pending vouchers", async () => {
    const { vaultPda, privateKey, publicKey } = await provisionVault(0);
    const swigAddress = await bindSwig(vaultPda, privateKey, publicKey);
    const destination = Keypair.generate().publicKey;
    const amount = BigInt(750_000);
    const signedAt = BigInt(Math.floor(Date.now() / 1000));

    const requestTx = await buildRequestWithdrawalTx(
      vaultPda,
      privateKey,
      publicKey,
      amount,
      destination,
      signedAt
    );
    await sendAndConfirmTransaction(provider.connection, requestTx, [
      (provider.wallet as anchor.Wallet).payer,
    ]);

    const finalizeTx = await buildFinalizeWithdrawalTx(
      vaultPda,
      privateKey,
      publicKey,
      amount,
      destination,
      swigAddress
    );
    await sendAndConfirmTransaction(provider.connection, finalizeTx, [
      (provider.wallet as anchor.Wallet).payer,
    ]);

    const vault = await program.account.vault.fetch(vaultPda);
    expect(vault.pendingWithdrawal).to.be.null;
  });

  it("finalize_withdrawal fails when swig not bound", async () => {
    const { vaultPda, privateKey, publicKey } = await provisionVault(0);
    const fakeSwig = Keypair.generate().publicKey;
    const destination = Keypair.generate().publicKey;
    const amount = BigInt(100_000);
    const signedAt = BigInt(Math.floor(Date.now() / 1000));

    const requestTx = await buildRequestWithdrawalTx(
      vaultPda,
      privateKey,
      publicKey,
      amount,
      destination,
      signedAt
    );
    await sendAndConfirmTransaction(provider.connection, requestTx, [
      (provider.wallet as anchor.Wallet).payer,
    ]);

    const finalizeTx = await buildFinalizeWithdrawalTx(
      vaultPda,
      privateKey,
      publicKey,
      amount,
      destination,
      fakeSwig
    );

    let threw = false;
    try {
      await sendAndConfirmTransaction(provider.connection, finalizeTx, [
        (provider.wallet as anchor.Wallet).payer,
      ]);
    } catch (err: any) {
      threw = true;
      expect(String(err)).to.match(/NoPendingWithdrawal|PasskeyVerificationFailed/);
    }
    expect(threw).to.equal(true);
  });
});
