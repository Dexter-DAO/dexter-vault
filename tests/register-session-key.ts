import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { DexterVault } from "../target/types/dexter_vault";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  Transaction,
} from "@solana/web3.js";
import { expect } from "chai";

import {
  generateP256Keypair,
  signOperationWithPasskey,
  buildSecp256r1VerifyInstruction,
  sessionRegisterMessage,
  sessionRevokeMessage,
  P256Keypair,
} from "./helpers/secp256r1";

/**
 * register_session_key + revoke_session_key — the session-key sub-authority layer.
 *
 * The passkey signs ONCE per tab to authorize an in-memory session keypair to
 * sign vouchers off-chain for the duration. The on-chain instruction records
 * the registration on the vault. revoke_session_key tears it down early.
 *
 * Both messages are deterministic byte sequences (180 / 128 bytes) with domain
 * separators. The TS helper sessionRegister/RevokeMessage must produce
 * byte-identical output to the Rust builders or every signature looks forged.
 */
describe("register_session_key + revoke_session_key (v2 session-key layer)", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.DexterVault as Program<DexterVault>;

  const authority = Keypair.generate();

  async function fund(pubkey: PublicKey) {
    const sig = await provider.connection.requestAirdrop(pubkey, 1_000_000_000);
    await provider.connection.confirmTransaction(sig, "confirmed");
  }

  before(async () => {
    await fund(authority.publicKey);
  });

  async function provisionVault(): Promise<{ vaultPda: PublicKey; passkey: P256Keypair }> {
    const identityClaim = new Uint8Array(32);
    crypto.getRandomValues(identityClaim);
    const passkey = generateP256Keypair();
    const [vaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), Buffer.from(identityClaim.slice(0, 16))],
      program.programId
    );
    await program.methods
      .initializeVault({
        passkeyPubkey: Array.from(passkey.publicKey),
        coolingOffSeconds: 0,
        identityClaim: Array.from(identityClaim),
      })
      .accounts({
        vault: vaultPda,
        payer: provider.wallet.publicKey,
        dexterAuthority: authority.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([authority])
      .rpc();
    return { vaultPda, passkey };
  }

  /** Build a fresh ed25519-shaped session pubkey. We only need 32 bytes the
   *  on-chain code can store — the on-chain program never validates it as a
   *  curve point because session signatures are verified off-chain. */
  function newSessionPubkey(): Uint8Array {
    return Keypair.generate().publicKey.toBytes();
  }

  function farFutureExpiry(): bigint {
    // 1 hour in the future, in unix seconds
    return BigInt(Math.floor(Date.now() / 1000) + 3600);
  }

  async function sendRegister(args: {
    vaultPda: PublicKey;
    passkey: P256Keypair;       // who signs the registration
    sessionPubkey: Uint8Array;
    maxAmount: bigint;
    expiresAt: bigint;
    allowedCounterparty: PublicKey;
    nonce: number;
  }): Promise<{ sig: string }> {
    const msg = sessionRegisterMessage({
      programId: program.programId,
      vaultPda: args.vaultPda,
      sessionPubkey: args.sessionPubkey,
      maxAmount: args.maxAmount,
      expiresAt: args.expiresAt,
      allowedCounterparty: args.allowedCounterparty,
      nonce: args.nonce,
    });
    const signed = signOperationWithPasskey(args.passkey, msg);
    const precompileIx = buildSecp256r1VerifyInstruction(
      args.passkey.publicKey,
      signed.signature,
      signed.precompileMessage
    );
    const vaultIx = await program.methods
      .registerSessionKey({
        sessionPubkey: Array.from(args.sessionPubkey),
        maxAmount: new anchor.BN(args.maxAmount.toString()),
        expiresAt: new anchor.BN(args.expiresAt.toString()),
        allowedCounterparty: args.allowedCounterparty,
        nonce: args.nonce,
        clientDataJson: Buffer.from(signed.clientDataJSON),
        authenticatorData: Buffer.from(signed.authenticatorData),
      })
      .accounts({ vault: args.vaultPda, instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY })
      .instruction();
    const tx = new Transaction().add(precompileIx, vaultIx);
    const sig = await provider.sendAndConfirm(tx);
    return { sig };
  }

  it("SUCCEEDS: a fresh registration writes active_session with the right fields", async () => {
    const { vaultPda, passkey } = await provisionVault();
    const sessionPubkey = newSessionPubkey();
    const counterparty = Keypair.generate().publicKey;
    const expiresAt = farFutureExpiry();

    await sendRegister({
      vaultPda,
      passkey,
      sessionPubkey,
      maxAmount: BigInt(1_000_000),
      expiresAt,
      allowedCounterparty: counterparty,
      nonce: 1,
    });

    const vault = await program.account.vault.fetch(vaultPda);
    expect(vault.activeSession, "active_session must be populated").to.not.equal(null);
    const sess = vault.activeSession!;
    expect(Buffer.from(sess.sessionPubkey)).to.deep.equal(Buffer.from(sessionPubkey));
    expect(sess.maxAmount.toString()).to.equal("1000000");
    expect(sess.expiresAt.toString()).to.equal(expiresAt.toString());
    expect(sess.allowedCounterparty.toBase58()).to.equal(counterparty.toBase58());
    expect(sess.nonce).to.equal(1);
    expect(sess.spent.toString()).to.equal("0");
  });

  it("REJECTS: foreign passkey signing the registration → instruction fails", async () => {
    const { vaultPda } = await provisionVault();
    const attacker = generateP256Keypair();
    try {
      await sendRegister({
        vaultPda,
        passkey: attacker,
        sessionPubkey: newSessionPubkey(),
        maxAmount: BigInt(1_000_000),
        expiresAt: farFutureExpiry(),
        allowedCounterparty: Keypair.generate().publicKey,
        nonce: 1,
      });
      expect.fail("registration with foreign passkey should have errored");
    } catch (e: any) {
      // The precompile verifies the signature against the wrong pubkey; the
      // sysvar introspection in verify_passkey_signed then rejects.
      expect(e.message).to.satisfy((m: string) =>
        m.includes("PasskeyVerificationFailed") || m.includes("custom program error")
      );
    }
  });

  it("REJECTS: max_amount = 0 → SessionCapZero", async () => {
    const { vaultPda, passkey } = await provisionVault();
    try {
      await sendRegister({
        vaultPda,
        passkey,
        sessionPubkey: newSessionPubkey(),
        maxAmount: BigInt(0),
        expiresAt: farFutureExpiry(),
        allowedCounterparty: Keypair.generate().publicKey,
        nonce: 1,
      });
      expect.fail("max_amount=0 should have errored");
    } catch (e: any) {
      expect(e.message).to.satisfy((m: string) =>
        m.includes("SessionCapZero") || m.includes("custom program error")
      );
    }
  });

  it("REJECTS: expires_at in the past → SessionExpiryInPast", async () => {
    const { vaultPda, passkey } = await provisionVault();
    try {
      await sendRegister({
        vaultPda,
        passkey,
        sessionPubkey: newSessionPubkey(),
        maxAmount: BigInt(1_000_000),
        expiresAt: BigInt(Math.floor(Date.now() / 1000) - 60),
        allowedCounterparty: Keypair.generate().publicKey,
        nonce: 1,
      });
      expect.fail("past expiry should have errored");
    } catch (e: any) {
      expect(e.message).to.satisfy((m: string) =>
        m.includes("SessionExpiryInPast") || m.includes("custom program error")
      );
    }
  });

  it("REJECTS: second register call while a session is already active → SessionAlreadyActive", async () => {
    const { vaultPda, passkey } = await provisionVault();
    // First registration succeeds.
    await sendRegister({
      vaultPda,
      passkey,
      sessionPubkey: newSessionPubkey(),
      maxAmount: BigInt(1_000_000),
      expiresAt: farFutureExpiry(),
      allowedCounterparty: Keypair.generate().publicKey,
      nonce: 1,
    });
    // Second registration (different session pubkey) should fail — there is
    // an unexpired session in place. Buyer must revoke first.
    try {
      await sendRegister({
        vaultPda,
        passkey,
        sessionPubkey: newSessionPubkey(),
        maxAmount: BigInt(1_000_000),
        expiresAt: farFutureExpiry(),
        allowedCounterparty: Keypair.generate().publicKey,
        nonce: 2,
      });
      expect.fail("double-register should have errored");
    } catch (e: any) {
      expect(e.message).to.satisfy((m: string) =>
        m.includes("SessionAlreadyActive") || m.includes("custom program error")
      );
    }
  });

  // ── revoke_session_key ───────────────────────────────────────────────

  async function sendRevoke(args: {
    vaultPda: PublicKey;
    passkey: P256Keypair;
    sessionPubkey: Uint8Array;
  }): Promise<{ sig: string }> {
    const msg = sessionRevokeMessage({
      programId: program.programId,
      vaultPda: args.vaultPda,
      sessionPubkey: args.sessionPubkey,
    });
    const signed = signOperationWithPasskey(args.passkey, msg);
    const precompileIx = buildSecp256r1VerifyInstruction(
      args.passkey.publicKey,
      signed.signature,
      signed.precompileMessage
    );
    const vaultIx = await program.methods
      .revokeSessionKey({
        clientDataJson: Buffer.from(signed.clientDataJSON),
        authenticatorData: Buffer.from(signed.authenticatorData),
      })
      .accounts({ vault: args.vaultPda, instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY })
      .instruction();
    const tx = new Transaction().add(precompileIx, vaultIx);
    const sig = await provider.sendAndConfirm(tx);
    return { sig };
  }

  it("REVOKE SUCCEEDS: passkey-signed revocation clears active_session", async () => {
    const { vaultPda, passkey } = await provisionVault();
    const sessionPubkey = newSessionPubkey();
    await sendRegister({
      vaultPda,
      passkey,
      sessionPubkey,
      maxAmount: BigInt(1_000_000),
      expiresAt: farFutureExpiry(),
      allowedCounterparty: Keypair.generate().publicKey,
      nonce: 1,
    });

    await sendRevoke({ vaultPda, passkey, sessionPubkey });

    const vault = await program.account.vault.fetch(vaultPda);
    expect(vault.activeSession, "active_session must be cleared after revoke").to.equal(null);
  });

  it("REVOKE REJECTS: no active session → NoActiveSession", async () => {
    const { vaultPda, passkey } = await provisionVault();
    try {
      await sendRevoke({ vaultPda, passkey, sessionPubkey: newSessionPubkey() });
      expect.fail("revoking with no active session should have errored");
    } catch (e: any) {
      expect(e.message).to.satisfy((m: string) =>
        m.includes("NoActiveSession") || m.includes("custom program error")
      );
    }
  });

  it("REVOKE REJECTS: replay an old revocation against a NEW session → reject", async () => {
    // This is the stale-revocation-replay defense. The revocation message
    // binds to the session pubkey being revoked. Even with a valid passkey
    // signature over an OLD session's revocation message, the on-chain
    // verifier will reconstruct the message using the CURRENT active
    // session's pubkey — which is different — so the precompile sibling
    // sees a different message and the signature fails to verify.
    const { vaultPda, passkey } = await provisionVault();
    const oldSession = newSessionPubkey();

    // Open + revoke an old session.
    await sendRegister({
      vaultPda,
      passkey,
      sessionPubkey: oldSession,
      maxAmount: BigInt(1_000_000),
      expiresAt: farFutureExpiry(),
      allowedCounterparty: Keypair.generate().publicKey,
      nonce: 1,
    });

    // Pre-build the OLD session's revocation signature (saved attacker tool).
    const oldRevokeMsg = sessionRevokeMessage({
      programId: program.programId,
      vaultPda,
      sessionPubkey: oldSession,
    });
    const oldSigned = signOperationWithPasskey(passkey, oldRevokeMsg);

    // Actually revoke (cleanly) the old session.
    await sendRevoke({ vaultPda, passkey, sessionPubkey: oldSession });

    // Open a NEW session with a different session pubkey.
    const newSession = newSessionPubkey();
    await sendRegister({
      vaultPda,
      passkey,
      sessionPubkey: newSession,
      maxAmount: BigInt(1_000_000),
      expiresAt: farFutureExpiry(),
      allowedCounterparty: Keypair.generate().publicKey,
      nonce: 2,
    });

    // Now try to replay the OLD revocation signature. The on-chain handler
    // will build the revocation message against the CURRENT (new) session
    // pubkey, which doesn't match what the attacker signed. The precompile
    // verifies the signature against the OLD message, but verify_passkey_signed
    // requires that message to equal the one the program reconstructed.
    const precompileIx = buildSecp256r1VerifyInstruction(
      passkey.publicKey,
      oldSigned.signature,
      oldSigned.precompileMessage
    );
    const vaultIx = await program.methods
      .revokeSessionKey({
        clientDataJson: Buffer.from(oldSigned.clientDataJSON),
        authenticatorData: Buffer.from(oldSigned.authenticatorData),
      })
      .accounts({ vault: vaultPda, instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY })
      .instruction();
    const tx = new Transaction().add(precompileIx, vaultIx);
    try {
      await provider.sendAndConfirm(tx);
      expect.fail("stale revocation replay should have errored");
    } catch (e: any) {
      // The challenge in old clientDataJSON hashes the OLD session's message,
      // but the on-chain code reconstructs the NEW session's message and
      // computes its sha256 — they don't match, so the challenge check fails.
      expect(e.message).to.satisfy((m: string) =>
        m.includes("PasskeyVerificationFailed") || m.includes("custom program error")
      );
    }

    // Sanity: the new session is still active and untouched.
    const vault = await program.account.vault.fetch(vaultPda);
    expect(vault.activeSession, "stale replay must not affect the new session").to.not.equal(null);
    expect(Buffer.from(vault.activeSession!.sessionPubkey)).to.deep.equal(Buffer.from(newSession));
  });
});
