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
  setSwigMessage,
  pollUntilAccountExists,
  pollUntilAccount,
  makeTestProvider,
} from "./helpers/secp256r1";

describe("set_swig", () => {
  const provider = makeTestProvider();
  const program = anchor.workspace.DexterVault as Program<DexterVault>;

  async function provisionVault() {
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
    await pollUntilAccountExists(provider.connection, vaultPda);
    return { vaultPda, keypair };
  }

  async function buildSetSwigTx(
    vaultPda: PublicKey,
    keypair: ReturnType<typeof generateP256Keypair>,
    swigAddress: PublicKey
  ): Promise<Transaction> {
    const opMsg = setSwigMessage(swigAddress);
    const signed = signOperationWithPasskey(keypair, opMsg);
    const precompileIx = buildSecp256r1VerifyInstruction(
      keypair.publicKey,
      signed.signature,
      signed.precompileMessage
    );
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

  it("binds the vault to a Swig address with a passkey signature", async () => {
    const { vaultPda, keypair } = await provisionVault();
    const swigAddress = Keypair.generate().publicKey;

    const tx = await buildSetSwigTx(vaultPda, keypair, swigAddress);
    await sendAndConfirmTransaction(provider.connection, tx, [
      (provider.wallet as anchor.Wallet).payer,
    ]);

    // Read replicas can lag behind even a finalized confirmation by 1-2s.
    // Poll the fetch until the swig binding propagates to the read side.
    const vault = await pollUntilAccount(
      () => program.account.vault.fetch(vaultPda),
      (v) => v.swigAddress.toBase58() === swigAddress.toBase58(),
    );
    expect(vault.swigAddress.toBase58()).to.equal(swigAddress.toBase58());
  });

  it("rejects re-binding when swig_address is already set (idempotent)", async () => {
    const { vaultPda, keypair } = await provisionVault();
    const firstSwig = Keypair.generate().publicKey;
    const secondSwig = Keypair.generate().publicKey;

    await sendAndConfirmTransaction(
      provider.connection,
      await buildSetSwigTx(vaultPda, keypair, firstSwig),
      [(provider.wallet as anchor.Wallet).payer]
    );

    let threw = false;
    try {
      await sendAndConfirmTransaction(
        provider.connection,
        await buildSetSwigTx(vaultPda, keypair, secondSwig),
        [(provider.wallet as anchor.Wallet).payer]
      );
    } catch (err: any) {
      threw = true;
      // VaultError::PasskeyVerificationFailed = anchor code 6003 (0x1773).
      // The on-chain failure surfaces as Custom error 6003 in the tx Status;
      // logs may be unavailable if confirmation-time error rather than preflight.
      const errStr = String(err);
      expect(errStr).to.match(/Custom":6003|Custom: 6003|0x1773|PasskeyVerificationFailed/);
    }
    expect(threw).to.equal(true);

    const vault = await program.account.vault.fetch(vaultPda);
    expect(vault.swigAddress.toBase58()).to.equal(firstSwig.toBase58());
  });
});
