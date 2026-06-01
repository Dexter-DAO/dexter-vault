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
  rotatePasskeyMessage,
  fundFromProvider,
  P256Keypair,
  makeTestProvider,
} from "./helpers/secp256r1";

/**
 * Key rotation — added before the Track 1 deploy so a vault is never
 * permanently locked to a stale key.
 *
 * rotate_passkey: the CURRENT passkey signs to set a NEW one (device move /
 *   recovery). A foreign passkey must be rejected.
 * rotate_dexter_authority: the CURRENT authority signs to hand off to a new
 *   one (session-master key rotation). A non-authority signer must be rejected.
 */
describe("key rotation", () => {
  const provider = makeTestProvider();
  const program = anchor.workspace.DexterVault as Program<DexterVault>;

  const authority = Keypair.generate();

  async function fund(pk: PublicKey) {
    await fundFromProvider(provider, pk);
  }

  async function provisionVault(): Promise<{ vaultPda: PublicKey; keypair: P256Keypair }> {
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
        dexterAuthority: authority.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([authority])
      .rpc();
    return { vaultPda, keypair };
  }

  before(async () => {
    await fund(authority.publicKey);
  });

  // ── rotate_passkey ────────────────────────────────────────────────────────

  async function buildRotatePasskeyTx(
    vaultPda: PublicKey,
    signingKeypair: P256Keypair,
    newPubkey: Uint8Array
  ): Promise<Transaction> {
    const opMsg = rotatePasskeyMessage(newPubkey);
    const signed = signOperationWithPasskey(signingKeypair, opMsg);
    const precompileIx = buildSecp256r1VerifyInstruction(
      signingKeypair.publicKey,
      signed.signature,
      signed.precompileMessage
    );
    const vaultIx = await program.methods
      .rotatePasskey({
        newPasskeyPubkey: Array.from(newPubkey),
        clientDataJson: Buffer.from(signed.clientDataJSON),
        authenticatorData: Buffer.from(signed.authenticatorData),
      })
      .accountsPartial({ vault: vaultPda, instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY })
      .instruction();
    return new Transaction().add(precompileIx, vaultIx);
  }

  it("rotate_passkey SUCCEEDS when the current passkey signs, and updates the key", async () => {
    const { vaultPda, keypair } = await provisionVault();
    const newKey = generateP256Keypair();

    await sendAndConfirmTransaction(
      provider.connection,
      await buildRotatePasskeyTx(vaultPda, keypair, newKey.publicKey),
      [(provider.wallet as anchor.Wallet).payer]
    );

    const vault = await program.account.vault.fetch(vaultPda);
    expect(Buffer.from(vault.passkeyPubkey)).to.deep.equal(Buffer.from(newKey.publicKey));
  });

  it("rotate_passkey REJECTS a foreign passkey (not the vault's current key)", async () => {
    const { vaultPda } = await provisionVault();
    const attackerKey = generateP256Keypair();
    const newKey = generateP256Keypair();

    let threw = false;
    try {
      await sendAndConfirmTransaction(
        provider.connection,
        // attacker signs with THEIR key, trying to set a new key they control
        await buildRotatePasskeyTx(vaultPda, attackerKey, newKey.publicKey),
        [(provider.wallet as anchor.Wallet).payer]
      );
    } catch (err: any) {
      threw = true;
      expect(String(err)).to.match(/PasskeyVerificationFailed/);
    }
    expect(threw, "foreign passkey rotation must be rejected").to.equal(true);
  });

  // ── rotate_dexter_authority ─────────────────────────────────────────────

  it("rotate_dexter_authority SUCCEEDS for the current authority, and updates it", async () => {
    const { vaultPda } = await provisionVault();
    const newAuthority = Keypair.generate();

    await program.methods
      .rotateDexterAuthority({ newDexterAuthority: newAuthority.publicKey })
      .accountsPartial({ vault: vaultPda, dexterAuthority: authority.publicKey })
      .signers([authority])
      .rpc();

    const vault = await program.account.vault.fetch(vaultPda);
    expect(vault.dexterAuthority.toBase58()).to.equal(newAuthority.publicKey.toBase58());

    // And the OLD authority can no longer settle (proves the rotation took).
    let threw = false;
    try {
      await program.methods
        .settleVoucher({ amount: new BN(1), increment: true })
        .accountsPartial({ vault: vaultPda, dexterAuthority: authority.publicKey })
        .signers([authority])
        .rpc();
    } catch {
      threw = true;
    }
    expect(threw, "old authority must lose settle rights after rotation").to.equal(true);
  });

  it("rotate_dexter_authority REJECTS a non-authority signer", async () => {
    const { vaultPda } = await provisionVault();
    const attacker = Keypair.generate();
    await fund(attacker.publicKey);

    let threw = false;
    try {
      await program.methods
        .rotateDexterAuthority({ newDexterAuthority: attacker.publicKey })
        .accountsPartial({ vault: vaultPda, dexterAuthority: attacker.publicKey })
        .signers([attacker])
        .rpc();
    } catch (err: any) {
      threw = true;
      expect(String(err)).to.match(/PasskeyVerificationFailed|has_one|ConstraintHasOne|2001/);
    }
    expect(threw, "non-authority rotation must be rejected").to.equal(true);
  });
});
