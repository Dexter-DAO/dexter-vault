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
  setSwigMessage,
} from "./helpers/secp256r1";

describe("set_swig", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.DexterVault as Program<DexterVault>;

  async function provisionVault() {
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
    return { vaultPda, privateKey, publicKey };
  }

  async function buildSetSwigTx(
    vaultPda: PublicKey,
    privateKey: Uint8Array,
    publicKey: Uint8Array,
    swigAddress: PublicKey
  ): Promise<Transaction> {
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
    return new Transaction().add(precompileIx, vaultIx);
  }

  it("binds the vault to a Swig address with a passkey signature", async () => {
    const { vaultPda, privateKey, publicKey } = await provisionVault();
    const swigAddress = Keypair.generate().publicKey;

    const tx = await buildSetSwigTx(vaultPda, privateKey, publicKey, swigAddress);
    await sendAndConfirmTransaction(provider.connection, tx, [
      (provider.wallet as anchor.Wallet).payer,
    ]);

    const vault = await program.account.vault.fetch(vaultPda);
    expect(vault.swigAddress.toBase58()).to.equal(swigAddress.toBase58());
  });

  it("rejects re-binding when swig_address is already set (idempotent)", async () => {
    const { vaultPda, privateKey, publicKey } = await provisionVault();
    const firstSwig = Keypair.generate().publicKey;
    const secondSwig = Keypair.generate().publicKey;

    const tx1 = await buildSetSwigTx(vaultPda, privateKey, publicKey, firstSwig);
    await sendAndConfirmTransaction(provider.connection, tx1, [
      (provider.wallet as anchor.Wallet).payer,
    ]);

    const tx2 = await buildSetSwigTx(vaultPda, privateKey, publicKey, secondSwig);
    let threw = false;
    try {
      await sendAndConfirmTransaction(provider.connection, tx2, [
        (provider.wallet as anchor.Wallet).payer,
      ]);
    } catch (err: any) {
      threw = true;
      expect(String(err)).to.match(/PasskeyVerificationFailed/);
    }
    expect(threw).to.equal(true);

    const vault = await program.account.vault.fetch(vaultPda);
    expect(vault.swigAddress.toBase58()).to.equal(firstSwig.toBase58());
  });
});
