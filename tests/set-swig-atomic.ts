// set_swig_atomic — TDD scaffold (Task 3 of the set_swig_atomic plan).
//
// These three tests MUST FAIL today. They fail because
// `buildSetSwigAtomicInstruction` does not yet exist in @dexterai/vault@0.1.3.
// Task 6 of the plan adds it to the SDK; Task 4 lands the Rust handler that
// turns these tests green. If any of these tests pass before Tasks 4+6 ship,
// STOP — something is wrong with the assumptions.
//
// Three scenarios are covered:
//   1. Happy path — single tx executes all 4 Swig CPIs + binds vault.swig_address
//   2. Atomic revert — if a Swig CPI fails, vault.swig_address stays default
//   3. Wrong-passkey rejection — precompile-sibling check fails on a different message
//
// Conventions match the existing dexter-vault harness:
//   - WebAuthn ceremony via tests/helpers/secp256r1.ts
//   - makeTestProvider() (mainnet, finalized commitment)
//   - .accountsPartial() and `.rpc()` for initialize_vault
//   - sendAndConfirmTransaction() for compound (precompile + vault ix) txs
//   - @dexterai/vault/instructions resolved via indirect-eval dynamic import
//     because dexter-vault's classic-node tsconfig doesn't honor the
//     package's `exports` map for subpath imports (same pattern as
//     tests/enroll-test-vault.ts).

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { DexterVault } from "../target/types/dexter_vault";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { expect } from "chai";

import {
  generateP256Keypair,
  signOperationWithPasskey,
  buildSecp256r1VerifyInstruction,
  setSwigMessage,
  makeTestProvider,
  pollUntilAccountExists,
  type P256Keypair,
} from "./helpers/secp256r1";

// Indirect-eval dynamic import — see tests/enroll-test-vault.ts for the rationale.
// `@dexterai/vault` is ESM-only with an `exports` map; classic-node resolution
// in dexter-vault's tsconfig won't reach the `/instructions` subpath statically.
const nativeImport = new Function("p", "return import(p)") as (
  p: string,
) => Promise<any>;

describe("set_swig_atomic", () => {
  const provider = makeTestProvider();
  const program = anchor.workspace.DexterVault as Program<DexterVault>;
  const feePayer = (provider.wallet as anchor.Wallet).payer;

  // A stable 32-byte seed for swig-id derivation across this suite.
  // Production uses the session-master seed; tests pass a deterministic
  // 32-byte buffer (matches the pattern in enroll-test-vault.ts).
  const hmacKey = (() => {
    const buf = new Uint8Array(32);
    crypto.getRandomValues(buf);
    return buf;
  })();

  // The session-master keypair (Swig role 2 in production). We mint a fresh
  // one here so the test doesn't depend on env. The on-chain handler does
  // not require this key to sign — it's just an arg to the SDK builder.
  const dexterMaster = Keypair.generate();

  let vaultPda: PublicKey;
  let identityClaim: Uint8Array;
  let passkey: P256Keypair;
  let expectedSwig: PublicKey;

  // SDK surface that Task 6 will add. Resolved at runtime; destructuring
  // succeeds today only because we use `let` + assign-or-undefined. The
  // actual call inside each `it()` will throw TypeError when the export
  // is missing — that's the TDD failure we expect.
  let sdkInstructions: any;
  let buildSetSwigAtomicFromIdentity: (params: {
    vaultPda: PublicKey;
    feePayer: PublicKey;
    dexterMasterPubkey: PublicKey;
    identitySeed: Uint8Array;
    hmacKey: Uint8Array;
    clientDataJSON: Uint8Array;
    authenticatorData: Uint8Array;
  }) => Promise<TransactionInstruction> | TransactionInstruction;
  let expectedSwigAddressFor: (
    identitySeed: Uint8Array,
    hmacKey: Uint8Array,
  ) => Promise<string>;

  before(async () => {
    sdkInstructions = await nativeImport("@dexterai/vault/instructions");
    buildSetSwigAtomicFromIdentity = sdkInstructions.buildSetSwigAtomicFromIdentity;
    expectedSwigAddressFor = sdkInstructions.expectedSwigAddressFor;

    // Provision a fresh vault for the happy-path test in the before() hook.
    // The other two tests provision their own vaults (different identity
    // claims) so each scenario has an isolated PDA.
    identityClaim = new Uint8Array(32);
    crypto.getRandomValues(identityClaim);
    passkey = generateP256Keypair();
    [vaultPda] = PublicKey.findProgramAddressSync(
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
        payer: feePayer.publicKey,
        dexterAuthority: feePayer.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    await pollUntilAccountExists(provider.connection, vaultPda);

    expectedSwig = new PublicKey(
      await expectedSwigAddressFor(identityClaim.slice(0, 16), hmacKey),
    );
  });

  it("happy path — single tx executes all 4 Swig CPIs + sets vault.swig_address", async () => {
    const opMsg = setSwigMessage(expectedSwig);
    const signed = signOperationWithPasskey(passkey, opMsg);
    const precompileIx = buildSecp256r1VerifyInstruction(
      passkey.publicKey,
      signed.signature,
      signed.precompileMessage,
    );

    const setSwigAtomicIx = await buildSetSwigAtomicFromIdentity({
      vaultPda,
      feePayer: feePayer.publicKey,
      dexterMasterPubkey: dexterMaster.publicKey,
      identitySeed: identityClaim.slice(0, 16),
      hmacKey,
      clientDataJSON: signed.clientDataJSON,
      authenticatorData: signed.authenticatorData,
    });

    const tx = new Transaction().add(precompileIx, setSwigAtomicIx);
    await sendAndConfirmTransaction(provider.connection, tx, [feePayer]);

    const vaultAcc = await program.account.vault.fetch(vaultPda);
    expect(vaultAcc.swigAddress.toBase58()).to.equal(expectedSwig.toBase58());

    const swigInfo = await provider.connection.getAccountInfo(expectedSwig);
    expect(swigInfo, "Swig account should exist after CPI").to.not.be.null;
    expect(swigInfo!.data.length).to.be.greaterThan(0);
  });

  it("atomic revert — if any Swig CPI fails, vault.swig_address remains default and no Swig account is created", async () => {
    // Fresh vault for isolation.
    const seed2 = new Uint8Array(32);
    crypto.getRandomValues(seed2);
    const passkey2 = generateP256Keypair();
    const [pda2] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), Buffer.from(seed2.slice(0, 16))],
      program.programId,
    );

    await program.methods
      .initializeVault({
        passkeyPubkey: Array.from(passkey2.publicKey),
        coolingOffSeconds: 0,
        identityClaim: Array.from(seed2),
      })
      .accountsPartial({
        vault: pda2,
        payer: feePayer.publicKey,
        dexterAuthority: feePayer.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    await pollUntilAccountExists(provider.connection, pda2);

    // The passkey signs over a BOGUS swig address. That bogus address is
    // also passed as the `swigAddress` account, so the on-chain handler
    // will attempt to CPI into Swig with an address that does NOT match
    // the canonical PDA derived from (identitySeed, hmacKey, dexterMaster).
    // The first Swig CPI (CreateV1) MUST fail; the whole tx MUST revert.
    const bogusSwig = Keypair.generate().publicKey;
    const signed = signOperationWithPasskey(passkey2, setSwigMessage(bogusSwig));
    const precompileIx = buildSecp256r1VerifyInstruction(
      passkey2.publicKey,
      signed.signature,
      signed.precompileMessage,
    );

    const realExpected = new PublicKey(
      await expectedSwigAddressFor(seed2.slice(0, 16), hmacKey),
    );

    const tamperedIx = await buildSetSwigAtomicFromIdentity({
      vaultPda: pda2,
      feePayer: feePayer.publicKey,
      dexterMasterPubkey: dexterMaster.publicKey,
      identitySeed: seed2.slice(0, 16),
      hmacKey,
      clientDataJSON: signed.clientDataJSON,
      authenticatorData: signed.authenticatorData,
    });
    const tx = new Transaction().add(precompileIx, tamperedIx);

    let err: unknown;
    try {
      await sendAndConfirmTransaction(provider.connection, tx, [feePayer]);
    } catch (e) {
      err = e;
    }
    expect(err, "tampered ix should fail").to.exist;

    // CRITICAL: the vault must NOT have been bound to anything. Solana's
    // tx atomicity guarantees this at the runtime level; we assert it
    // explicitly because the whole point of set_swig_atomic is that
    // partial state (vault.swig_address set but no Swig account) is
    // structurally impossible.
    const vaultAcc = await program.account.vault.fetch(pda2);
    expect(vaultAcc.swigAddress.toBase58()).to.equal(
      PublicKey.default.toBase58(),
      "vault.swig_address MUST remain zero after revert",
    );

    const bogusInfo = await provider.connection.getAccountInfo(bogusSwig);
    expect(bogusInfo, "bogus Swig must not exist post-revert").to.be.null;
    const realInfo = await provider.connection.getAccountInfo(realExpected);
    expect(realInfo, "real Swig must also not exist (CPI never completed)").to.be.null;
  });

  it("wrong-passkey rejection — precompile-sibling check fails if signature is over a different operation", async () => {
    // Fresh vault for isolation.
    const seed3 = new Uint8Array(32);
    crypto.getRandomValues(seed3);
    const passkey3 = generateP256Keypair();
    const [pda3] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), Buffer.from(seed3.slice(0, 16))],
      program.programId,
    );

    await program.methods
      .initializeVault({
        passkeyPubkey: Array.from(passkey3.publicKey),
        coolingOffSeconds: 0,
        identityClaim: Array.from(seed3),
      })
      .accountsPartial({
        vault: pda3,
        payer: feePayer.publicKey,
        dexterAuthority: feePayer.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    await pollUntilAccountExists(provider.connection, pda3);

    const expected3 = new PublicKey(
      await expectedSwigAddressFor(seed3.slice(0, 16), hmacKey),
    );

    // Sign over a DIFFERENT operation ("request_withdrawal"-shaped message
    // instead of "set_swig"||addr). The secp256r1 precompile will verify
    // the signature fine — but the vault's sibling check reconstructs the
    // expected message as "set_swig"||expected3 and compares against the
    // precompile's published message. The bytes don't match, so the
    // handler fails with PasskeyVerificationFailed (anchor code 6003).
    const wrongMsg = new TextEncoder().encode("withdraw_or_whatever_not_set_swig");
    const signed = signOperationWithPasskey(passkey3, wrongMsg);
    const precompileIx = buildSecp256r1VerifyInstruction(
      passkey3.publicKey,
      signed.signature,
      signed.precompileMessage,
    );

    const ix = await buildSetSwigAtomicFromIdentity({
      vaultPda: pda3,
      feePayer: feePayer.publicKey,
      dexterMasterPubkey: dexterMaster.publicKey,
      identitySeed: seed3.slice(0, 16),
      hmacKey,
      clientDataJSON: signed.clientDataJSON,
      authenticatorData: signed.authenticatorData,
    });
    const tx = new Transaction().add(precompileIx, ix);

    let err: unknown;
    try {
      await sendAndConfirmTransaction(provider.connection, tx, [feePayer]);
    } catch (e) {
      err = e;
    }
    expect(err, "wrong-message ceremony must be rejected").to.exist;
    expect(String(err)).to.match(
      /Custom":6003|Custom: 6003|0x1773|PasskeyVerificationFailed/,
      "must surface the passkey verification error",
    );

    // And vault.swig_address must still be default.
    const vaultAcc = await program.account.vault.fetch(pda3);
    expect(vaultAcc.swigAddress.toBase58()).to.equal(
      PublicKey.default.toBase58(),
      "vault.swig_address MUST remain zero after wrong-passkey rejection",
    );
  });
});
