// register_session_key — THE GATE (Task 8).
//
// HISTORY: Pre-Task-8, this file proved the PUBLISHED @dexterai/vault 0.4.1
// client stack produces a V2/188 session-registration that the LIVE mainnet
// program accepts. Task 8 added three new accounts to the on-chain
// instruction (vault_usdc_ata + swig + swig_wallet_address) so the
// overcommit invariant per V0.3 Decision 1 can gate at registration time.
// The 0.4.1 SDK builder pre-dates the new account list and will be
// republished as 0.4.2 after the combined Phase 1 deploy lands.
//
// Until the SDK is republished, the SDK-path tests are SKIPPED — the
// published builder cannot drive the new on-chain instruction. The
// substance of "V2/188 message + passkey ceremony" is still proven by
// tests/revolving-meter.ts (registration describe block) and the new
// tests/register-session-overcommit.ts which both use the in-repo
// `tests/helpers/register-bootstrap.ts` helper that knows about the new
// accounts.

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { DexterVault } from "../target/types/dexter_vault";
import {
  Keypair,
  PublicKey,
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
  pollUntilAccount,
  type P256Keypair,
} from "./helpers/secp256r1";
import {
  bootstrapForRegister,
  registerSessionV2,
} from "./helpers/register-bootstrap";

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

describe("register_session_key — V2/188 registration (mainnet, Task 8 gate)", () => {
  const provider = makeTestProvider();
  const program = anchor.workspace.DexterVault as Program<DexterVault>;

  it("SUCCEEDS: V2/188 registration with the new account triple; active_session reflects max_revolving_capacity", async () => {
    // Fund vault $10; register session with $5 cap → combined 5 + 0 = 5 ≤ 10. OK.
    const FUND = 10_000_000n;
    const MAX_AMOUNT = 5_000_000n;
    const MAX_REVOLVING = 2_000_000n;

    const bootstrap = await bootstrapForRegister(program, provider, {
      usdcFundingAmount: FUND,
    });
    const expiresAt = BigInt(Math.floor(Date.now() / 1000) + 3600);
    const allowedCounterparty = Keypair.generate().publicKey;

    const { sessionKeypair, signature } = await registerSessionV2(
      program,
      provider,
      {
        vaultPda: bootstrap.vaultPda,
        passkey: bootstrap.passkey,
        vaultUsdcAta: bootstrap.sourceAta,
        swigAddress: bootstrap.swigAddress,
        swigWalletAddress: bootstrap.swigWalletAddress,
        maxAmount: MAX_AMOUNT,
        maxRevolvingCapacity: MAX_REVOLVING,
        allowedCounterparty,
        expiresAt,
        nonce: 1,
      },
    );
    console.log(`\n=== Task 8 register gate ===`);
    console.log(`vault:   ${bootstrap.vaultPda.toBase58()}`);
    console.log(`tx:      ${signature}`);

    // Read back the on-chain active_session, polling past any read-replica lag.
    const vault = await pollUntilAccount(
      () => program.account.vault.fetch(bootstrap.vaultPda),
      (v: any) => v.activeSession != null,
    );
    expect(vault.activeSession, "active_session must be populated").to.not.equal(
      null,
    );
    const sess = vault.activeSession!;

    expect(Buffer.from(sess.sessionPubkey)).to.deep.equal(
      Buffer.from(sessionKeypair.publicKey.toBytes()),
    );
    expect(sess.maxAmount.toString()).to.equal(MAX_AMOUNT.toString());
    expect(sess.maxRevolvingCapacity.toString()).to.equal(
      MAX_REVOLVING.toString(),
    );
    expect(sess.currentOutstanding.toString()).to.equal("0");
    expect(sess.expiresAt.toString()).to.equal(expiresAt.toString());
    expect(sess.allowedCounterparty.toBase58()).to.equal(
      allowedCounterparty.toBase58(),
    );
    expect(sess.nonce).to.equal(1);
    expect(sess.spent.toString()).to.equal("0");

    console.log(
      `active_session.maxRevolvingCapacity=${sess.maxRevolvingCapacity.toString()} ` +
        `(expected ${MAX_REVOLVING.toString()})`,
    );
    console.log(
      `active_session.maxAmount=${sess.maxAmount.toString()} ` +
        `currentOutstanding=${sess.currentOutstanding.toString()} ` +
        `spent=${sess.spent.toString()}`,
    );
    console.log(`*** GATE PASSED ***\n`);
  });

  it("REJECTS: a foreign passkey signing the V2 message → registration fails", async () => {
    // Same SDK message + instruction, but a DIFFERENT passkey signs it. The
    // secp256r1 precompile verifies the signature against the attacker's
    // pubkey while the on-chain handler reconstructs the message and checks
    // the precompile sibling against the vault's bound passkey → mismatch
    // → reject. The vault remains bound to its original passkey.
    const bootstrap = await bootstrapForRegister(program, provider, {
      usdcFundingAmount: 10_000_000n,
    });
    const attacker = generateP256Keypair();
    try {
      await registerSessionV2(program, provider, {
        vaultPda: bootstrap.vaultPda,
        // Swap in the attacker's passkey for the registration ceremony.
        passkey: attacker,
        vaultUsdcAta: bootstrap.sourceAta,
        swigAddress: bootstrap.swigAddress,
        swigWalletAddress: bootstrap.swigWalletAddress,
        maxAmount: 5_000_000n,
        maxRevolvingCapacity: 2_000_000n,
      });
      expect.fail("registration with a foreign passkey should have errored");
    } catch (e: any) {
      // Pin the specific passkey-verification error (code 6003 / 0x1773),
      // matching the sibling passkey-rejection tests in set-swig.ts /
      // set-swig-atomic.ts — proves the rejection is the passkey check,
      // not some other custom error.
      expect(e.message).to.satisfy((m: string) =>
        m.includes("PasskeyVerificationFailed") ||
        m.includes("6003") ||
        m.includes("0x1773"),
      );
    }
  });
});

// ── Published-SDK path: SKIPPED pending @dexterai/vault 0.4.2 republish ─────
//
// The 0.4.1 SDK predates Task 8 (it builds the register instruction with the
// old [vault, instructions_sysvar] account list, missing the three new gating
// accounts). The on-chain handler now requires the new accounts. After the
// combined Phase 1 deploy lands and the SDK is republished as 0.4.2, this
// block can be unskipped to re-prove the published-client end-to-end path.
describe.skip("register_session_key — published @dexterai/vault SDK path (post-0.4.2 only)", () => {
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
  });

  it("SDK-built V2/188 registration is accepted", async () => {
    const bootstrap = await bootstrapForRegister(program, provider, {
      usdcFundingAmount: 10_000_000n,
    });
    const sessionPubkey = Keypair.generate().publicKey.toBytes();
    const counterparty = Keypair.generate().publicKey;
    const expiresAt = BigInt(Math.floor(Date.now() / 1000) + 3600);
    const maxAmount = 5_000_000n;
    const maxRevolvingCapacity = 2_000_000n;

    const msg = sessionRegisterMessage({
      programId: program.programId,
      vaultPda: bootstrap.vaultPda,
      sessionPubkey,
      maxAmount,
      expiresAt,
      allowedCounterparty: counterparty,
      nonce: 1,
      maxRevolvingCapacity,
    });
    const signed = signOperationWithPasskey(bootstrap.passkey, msg);
    const precompileIx = buildSecp256r1VerifyInstruction(
      bootstrap.passkey.publicKey,
      signed.signature,
      signed.precompileMessage,
    );
    const vaultIx = buildRegisterSessionKeyInstruction({
      vaultPda: bootstrap.vaultPda,
      sessionPubkey,
      maxAmount,
      expiresAt,
      allowedCounterparty: counterparty,
      nonce: 1,
      maxRevolvingCapacity,
      clientDataJSON: signed.clientDataJSON,
      authenticatorData: signed.authenticatorData,
    });

    // Sanity: the SDK targets the program & sysvar the live handler expects.
    expect(vaultIx.programId.toBase58()).to.equal(program.programId.toBase58());
    const sysvarKey = vaultIx.keys.find((k) =>
      k.pubkey.equals(SYSVAR_INSTRUCTIONS_PUBKEY),
    );
    expect(sysvarKey).to.not.be.undefined;

    const tx = new Transaction().add(precompileIx, vaultIx);
    const sig = await provider.sendAndConfirm(tx);
    expect(sig).to.be.a("string");
  });
});
