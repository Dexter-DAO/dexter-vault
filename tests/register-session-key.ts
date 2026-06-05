// register_session_key — THE GATE (Task 8).
//
// Proves the PUBLISHED @dexterai/vault 0.4.1 client stack produces a V2/188
// session-registration that the LIVE mainnet dexter-vault program accepts.
//
// The PROGRAM side (V2/188 register + settle) is already proven by
// tests/revolving-meter.ts — but that file hand-builds the 188-byte message
// with a TEST-LOCAL `sessionRegisterMessageV2` helper. This file is different:
// the registration MESSAGE and the on-chain INSTRUCTION both come from the
// PUBLISHED SDK:
//
//   - sessionRegisterMessage            (@dexterai/vault/messages, 188-byte V2)
//   - buildRegisterSessionKeyInstruction(@dexterai/vault/instructions)
//
// The passkey/WebAuthn ceremony (signOperationWithPasskey) and the secp256r1
// precompile builder remain the test harness's environmental helpers — they
// synthesize the browser WebAuthn ceremony that has no Node equivalent. The
// NOVEL thing under test is that the SDK's 188 bytes match what the deployed
// program reconstructs, so the passkey signature verifies and active_session
// reflects what was registered (including max_revolving_capacity).
//
// @dexterai/vault is ESM-only with an `exports` map; this repo's classic-node
// tsconfig won't reach the `/messages` and `/instructions` subpaths via static
// import, so we resolve them with an indirect-eval dynamic import — the same
// pattern as tests/set-swig-atomic.ts and tests/enroll-test-vault.ts.

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { DexterVault } from "../target/types/dexter_vault";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import { expect } from "chai";

import {
  generateP256Keypair,
  signOperationWithPasskey,
  buildSecp256r1VerifyInstruction,
  makeTestProvider,
  pollUntilAccountExists,
  pollUntilAccount,
  type P256Keypair,
} from "./helpers/secp256r1";

// Indirect-eval dynamic import — see tests/set-swig-atomic.ts for the rationale.
// `@dexterai/vault` is ESM-only with an `exports` map; classic-node resolution
// in dexter-vault's tsconfig won't reach the subpaths statically.
const nativeImport = new Function("p", "return import(p)") as (
  p: string,
) => Promise<any>;

// ── SDK types (mirrored locally only for call-site type-safety; the actual
//    functions are the PUBLISHED 0.4.1 exports loaded at runtime). ──────────
type SessionRegisterMessageFn = (args: {
  programId: PublicKey;
  vaultPda: PublicKey;
  sessionPubkey: Uint8Array;
  maxAmount: bigint;
  expiresAt: bigint;
  allowedCounterparty: PublicKey;
  nonce: number;
  maxRevolvingCapacity: bigint;
}) => Uint8Array;

type BuildRegisterSessionKeyInstructionFn = (args: {
  vaultPda: PublicKey;
  sessionPubkey: Uint8Array;
  maxAmount: bigint;
  expiresAt: bigint;
  allowedCounterparty: PublicKey;
  nonce: number;
  maxRevolvingCapacity: bigint;
  clientDataJSON: Uint8Array;
  authenticatorData: Uint8Array;
}) => TransactionInstruction;

describe("register_session_key — published @dexterai/vault 0.4.1 SDK path (V2/188, mainnet)", () => {
  const provider = makeTestProvider();
  const program = anchor.workspace.DexterVault as Program<DexterVault>;

  // Resolved at runtime from the PUBLISHED SDK (not a test-local helper).
  let sessionRegisterMessage: SessionRegisterMessageFn;
  let buildRegisterSessionKeyInstruction: BuildRegisterSessionKeyInstructionFn;

  before(async () => {
    const messages = await nativeImport("@dexterai/vault/messages");
    const instructions = await nativeImport("@dexterai/vault/instructions");
    sessionRegisterMessage = messages.sessionRegisterMessage;
    buildRegisterSessionKeyInstruction =
      instructions.buildRegisterSessionKeyInstruction;
    if (typeof sessionRegisterMessage !== "function") {
      throw new Error("SDK did not export sessionRegisterMessage");
    }
    if (typeof buildRegisterSessionKeyInstruction !== "function") {
      throw new Error("SDK did not export buildRegisterSessionKeyInstruction");
    }
  });

  // Provision a fresh V3 vault bound to a passkey. initialize_vault is NOT the
  // thing under test (it's the standard provisioning the SDK registration runs
  // against), so we use the Anchor method directly — mirrors the lean
  // registerSessionWithCapacity helper in revolving-meter.ts.
  async function provisionVault(): Promise<{
    vaultPda: PublicKey;
    passkey: P256Keypair;
  }> {
    const identityClaim = new Uint8Array(32);
    crypto.getRandomValues(identityClaim);
    const passkey = generateP256Keypair();
    const [vaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), Buffer.from(identityClaim.slice(0, 16))],
      program.programId,
    );
    await program.methods
      .initializeVault({
        passkeyPubkey: Array.from(passkey.publicKey),
        coolingOffSeconds: 0,
        identityClaim: Array.from(identityClaim),
      })
      .accountsPartial({
        vault: vaultPda,
        payer: provider.wallet.publicKey,
        // dexterAuthority = provider wallet so no extra signer is needed.
        dexterAuthority: provider.wallet.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    // Guard against read-after-write propagation lag before the next tx reads
    // the vault account.
    await pollUntilAccountExists(provider.connection, vaultPda);
    return { vaultPda, passkey };
  }

  /**
   * Register a session via the PUBLISHED SDK path:
   *   1. SDK sessionRegisterMessage(...)         → the 188-byte V2 message
   *   2. passkey signs it (WebAuthn ceremony helper)
   *   3. secp256r1 precompile verify ix over that message
   *   4. SDK buildRegisterSessionKeyInstruction(...) → the on-chain register ix
   *   5. submit [precompile, register] atomically (precompile FIRST)
   */
  async function registerViaSdk(args: {
    vaultPda: PublicKey;
    passkey: P256Keypair; // signs the registration
    sessionPubkey: Uint8Array;
    maxAmount: bigint;
    expiresAt: bigint;
    allowedCounterparty: PublicKey;
    nonce: number;
    maxRevolvingCapacity: bigint;
  }): Promise<{ sig: string }> {
    // (1) SDK message — 188-byte V2, includes max_revolving_capacity.
    const msg = sessionRegisterMessage({
      programId: program.programId,
      vaultPda: args.vaultPda,
      sessionPubkey: args.sessionPubkey,
      maxAmount: args.maxAmount,
      expiresAt: args.expiresAt,
      allowedCounterparty: args.allowedCounterparty,
      nonce: args.nonce,
      maxRevolvingCapacity: args.maxRevolvingCapacity,
    });
    if (msg.length !== 188) {
      throw new Error(`SDK message expected 188 bytes, got ${msg.length}`);
    }

    // (2) passkey signs the SDK message (synthesized WebAuthn ceremony).
    const signed = signOperationWithPasskey(args.passkey, msg);

    // (3) secp256r1 precompile verify sibling.
    const precompileIx = buildSecp256r1VerifyInstruction(
      args.passkey.publicKey,
      signed.signature,
      signed.precompileMessage,
    );

    // (4) SDK on-chain instruction — discriminator, Borsh args, accounts, and
    //     program id all come from @dexterai/vault@0.4.1.
    const vaultIx = buildRegisterSessionKeyInstruction({
      vaultPda: args.vaultPda,
      sessionPubkey: args.sessionPubkey,
      maxAmount: args.maxAmount,
      expiresAt: args.expiresAt,
      allowedCounterparty: args.allowedCounterparty,
      nonce: args.nonce,
      maxRevolvingCapacity: args.maxRevolvingCapacity,
      clientDataJSON: signed.clientDataJSON,
      authenticatorData: signed.authenticatorData,
    });

    // Sanity: the SDK targets the program & sysvar the live handler expects.
    expect(vaultIx.programId.toBase58()).to.equal(program.programId.toBase58());
    const sysvarKey = vaultIx.keys.find((k) =>
      k.pubkey.equals(SYSVAR_INSTRUCTIONS_PUBKEY),
    );
    expect(sysvarKey, "register ix must reference the instructions sysvar").to
      .not.be.undefined;

    // (5) precompile FIRST, then register — atomic.
    const tx = new Transaction().add(precompileIx, vaultIx);
    const sig = await provider.sendAndConfirm(tx);
    return { sig };
  }

  it("SUCCEEDS: SDK-built V2/188 registration is accepted; active_session reflects max_revolving_capacity", async () => {
    const { vaultPda, passkey } = await provisionVault();

    const sessionKeypair = Keypair.generate();
    const sessionPubkey = sessionKeypair.publicKey.toBytes();
    const counterparty = Keypair.generate().publicKey;
    const expiresAt = BigInt(Math.floor(Date.now() / 1000) + 3600);
    const maxAmount = BigInt(10_000_000); // $10
    const maxRevolvingCapacity = BigInt(2_000_000); // $2 — must be > 0 for V2
    const nonce = 1;

    const { sig } = await registerViaSdk({
      vaultPda,
      passkey,
      sessionPubkey,
      maxAmount,
      expiresAt,
      allowedCounterparty: counterparty,
      nonce,
      maxRevolvingCapacity,
    });
    console.log(`\n=== SDK V2/188 REGISTER GATE ===`);
    console.log(`vault:   ${vaultPda.toBase58()}`);
    console.log(`tx:      ${sig}`);

    // Read back the on-chain active_session, polling past any read replica lag.
    const vault = await pollUntilAccount(
      () => program.account.vault.fetch(vaultPda),
      (v: any) => v.activeSession != null,
    );
    expect(vault.activeSession, "active_session must be populated").to.not.equal(
      null,
    );
    const sess = vault.activeSession!;

    // The registered session pubkey round-tripped.
    expect(Buffer.from(sess.sessionPubkey)).to.deep.equal(
      Buffer.from(sessionPubkey),
    );
    // max_amount the SDK encoded.
    expect(sess.maxAmount.toString()).to.equal(maxAmount.toString());
    // THE V2 assertion: max_revolving_capacity is stored from the 188-byte msg.
    expect(sess.maxRevolvingCapacity.toString()).to.equal(
      maxRevolvingCapacity.toString(),
    );
    // current_outstanding starts at zero on a fresh registration.
    expect(sess.currentOutstanding.toString()).to.equal("0");
    expect(sess.expiresAt.toString()).to.equal(expiresAt.toString());
    expect(sess.allowedCounterparty.toBase58()).to.equal(
      counterparty.toBase58(),
    );
    expect(sess.nonce).to.equal(nonce);
    expect(sess.spent.toString()).to.equal("0");

    console.log(
      `active_session.maxRevolvingCapacity=${sess.maxRevolvingCapacity.toString()} ` +
        `(expected ${maxRevolvingCapacity.toString()})`,
    );
    console.log(
      `active_session.maxAmount=${sess.maxAmount.toString()} ` +
        `currentOutstanding=${sess.currentOutstanding.toString()} ` +
        `spent=${sess.spent.toString()}`,
    );
    console.log(`*** GATE PASSED: published SDK V2/188 accepted by live program ***\n`);
  });

  it("REJECTS: a foreign passkey signing the SDK message → registration fails", async () => {
    // Same SDK message + instruction, but a DIFFERENT passkey signs it. The
    // secp256r1 precompile verifies the signature against the attacker's
    // pubkey while the on-chain handler reconstructs the message and checks the
    // precompile sibling against the vault's bound passkey — mismatch → reject.
    // This proves the SDK's 188 bytes are the thing being authenticated.
    const { vaultPda } = await provisionVault();
    const attacker = generateP256Keypair();
    try {
      await registerViaSdk({
        vaultPda,
        passkey: attacker,
        sessionPubkey: Keypair.generate().publicKey.toBytes(),
        maxAmount: BigInt(10_000_000),
        expiresAt: BigInt(Math.floor(Date.now() / 1000) + 3600),
        allowedCounterparty: Keypair.generate().publicKey,
        nonce: 1,
        maxRevolvingCapacity: BigInt(2_000_000),
      });
      expect.fail("registration with a foreign passkey should have errored");
    } catch (e: any) {
      // Pin the specific passkey-verification error (code 6003 / 0x1773), matching
      // the sibling passkey-rejection tests in set-swig.ts / set-swig-atomic.ts —
      // proves the rejection is the passkey check, not some other custom error.
      expect(e.message).to.satisfy((m: string) =>
        m.includes("PasskeyVerificationFailed") ||
        m.includes("6003") ||
        m.includes("0x1773"),
      );
    }
  });
});
