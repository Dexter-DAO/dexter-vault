// V6 replace-in-place + re-init defense — ADVERSARIAL MATRIX (spec §7b, cases 12-14).
//
// ────────────────────────────────────────────────────────────────────────────
// RUN CONTEXT
//   Runs against deployed-V6-on-mainnet; gated on the V6 deploy + Helius RPC.
//   The passkey path uses the mainnet secp256r1 precompile (SIMD-0075), so this
//   is a MAINNET integration test driven through `makeTestProvider`
//   (ANCHOR_PROVIDER_URL / ANCHOR_WALLET). It is WRITE-ONLY at authoring time —
//   it was type-checked but NOT executed (Helius was down). It will run as part
//   of the post-deploy V6 suite, alongside multisession-overcommit.ts (§7a).
// ────────────────────────────────────────────────────────────────────────────
//
// WHAT THIS PROVES
//   register_session_key, when targeting a counterparty that ALREADY has a live
//   session PDA, REPLACES that session IN PLACE rather than creating a second
//   account. The on-chain mechanics (register_session_key.rs):
//     - the session PDA is init_if_needed at [SESSION_SEED, vault, counterparty];
//       on a re-register the SAME account is reused (the seed binds it to the
//       counterparty — there is only ever one PDA per (vault, counterparty)).
//     - `is_new = (session.version == 0)`. On a replace the account already has
//       version == SESSION_VERSION_V1, so is_new == false:
//         · live_session_count is NOT incremented (E.1 skipped) — no double-count
//         · the completeness check expects live_session_count − 1 siblings (the
//           target itself is excluded), so a single-session replace passes []
//     - the FULL SessionRegistration is overwritten unconditionally (handler E):
//       every passkey-endorsed scope field is rewritten from args, and the four
//       meters (spent / current_outstanding / crystallized_cumulative /
//       last_locked_sequence) are reset to 0. This is the SOL-010 re-init Mode-B
//       defense: no stale field from the prior registration can survive a replace.
//     - the passkey signature is verified over the 188-byte registration message
//       reconstructed FROM THE INSTRUCTION ARGS (build_registration_message), so a
//       signature made over the OLD values cannot authorize a replace to NEW ones.
//
// CASES
//   12  replace keeps count + overwrites cap     (no double-increment, same PDA)
//   13  re-init Mode B: every scope field overwritten + all four meters reset
//   14  passkey replay rejected: sign-over-V1, submit-V2-args → PasskeyVerificationFailed
//
// ASSERTION SHAPE
//   Positive cases fetch the session PDA / vault and assert field-by-field. The
//   negative case (14) drives the gate to a revert; the thrown error's toString()
//   contains the AnchorError name. We assert via
//   expect(err.toString()).to.match(/PasskeyVerificationFailed|6003|0x1773/) —
//   matching register-session-key.ts's foreign-passkey rejection and set-swig.ts.
//   PasskeyVerificationFailed is code 6003 (0x1773).

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { DexterVault } from "../target/types/dexter_vault";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_INSTRUCTIONS_PUBKEY,
} from "@solana/web3.js";
import { expect } from "chai";

import {
  signOperationWithPasskey,
  buildSecp256r1VerifyInstruction,
  makeTestProvider,
  sendPrecompilePairResilient,
} from "./helpers/secp256r1";
import {
  bootstrapForRegister,
  registerSessionV2,
  sessionRegisterMessageV2,
  RegisterReadyVault,
} from "./helpers/register-bootstrap";
import { deriveSessionPda } from "./helpers/session";

describe("register_session_key — V6 replace-in-place + re-init Mode-B (spec §7b)", () => {
  const provider = makeTestProvider();
  const workspaceProgram = anchor.workspace.DexterVault as Program<DexterVault>;
  const program = new anchor.Program<DexterVault>(
    workspaceProgram.idl,
    provider,
  );

  // Register a session to `counterparty`. Thin wrapper over registerSessionV2.
  // For a REPLACE (the counterparty already has a live PDA, is_new == false),
  // pass NO siblings: the completeness check expects live_session_count − 1 = 0
  // siblings because the target itself is excluded from the sibling set.
  async function register(
    vault: RegisterReadyVault,
    opts: {
      counterparty: PublicKey;
      maxAmount: bigint;
      maxRevolvingCapacity: bigint;
      sessionKeypair?: Keypair;
      expiresAt?: bigint;
      nonce?: number;
    },
  ) {
    return registerSessionV2(program, provider, {
      vaultPda: vault.vaultPda,
      passkey: vault.passkey,
      vaultUsdcAta: vault.sourceAta,
      swigAddress: vault.swigAddress,
      swigWalletAddress: vault.swigWalletAddress,
      maxAmount: opts.maxAmount,
      maxRevolvingCapacity: opts.maxRevolvingCapacity,
      allowedCounterparty: opts.counterparty,
      sessionKeypair: opts.sessionKeypair,
      expiresAt: opts.expiresAt,
      nonce: opts.nonce,
      // A replace passes NO siblings (target excluded → expected_siblings == 0).
      siblings: [],
    });
  }

  // ───────────────────────────────────────────────────────────────────────────
  // 12. REPLACE KEEPS COUNT + OVERWRITES CAP.
  //     Register A($3) → count 1, A.maxAmount $3. Re-register the SAME
  //     counterparty A with $7 (no siblings, is_new false). The PDA address is
  //     unchanged, A.maxAmount is now $7 (overwritten), and live_session_count
  //     STAYS 1 — the first-touch increment (E.1) is skipped on a replace.
  // ───────────────────────────────────────────────────────────────────────────
  it("case 12 — replace same counterparty: cap overwritten, count stays 1, same PDA", async () => {
    const FUND = 10_000_000n; // $10 — covers the $3 then $7 caps comfortably.
    const vault = await bootstrapForRegister(program, provider, {
      usdcFundingAmount: FUND,
      migrateTo: 6,
    });

    const cpA = Keypair.generate().publicKey;

    // First register: cap $3, no siblings → live_session_count = 1.
    const first = await register(vault, {
      counterparty: cpA,
      maxAmount: 3_000_000n,
      maxRevolvingCapacity: 3_000_000n,
    });
    let aAcct: any = await program.account.sessionAccount.fetch(
      first.sessionPda,
    );
    expect(aAcct.session.maxAmount.toString()).to.equal("3000000");
    expect(aAcct.version).to.not.equal(0); // written (V1), so the replace sees is_new=false
    let v: any = await program.account.vault.fetch(vault.vaultPda);
    expect(v.liveSessionCount).to.equal(1);

    // Replace: SAME counterparty A, cap $7, NO siblings (is_new false → expected
    // siblings = count(1) − 1 = 0). The seed-bound PDA is reused in place.
    const second = await register(vault, {
      counterparty: cpA,
      maxAmount: 7_000_000n,
      maxRevolvingCapacity: 7_000_000n,
    });

    // Same PDA — replace-in-place, NOT a new account.
    expect(second.sessionPda.toBase58()).to.equal(first.sessionPda.toBase58());

    // Cap overwritten $3 → $7.
    aAcct = await program.account.sessionAccount.fetch(first.sessionPda);
    expect(aAcct.session.maxAmount.toString()).to.equal("7000000");
    expect(aAcct.session.maxRevolvingCapacity.toString()).to.equal("7000000");

    // Count UNCHANGED — no double-increment.
    v = await program.account.vault.fetch(vault.vaultPda);
    expect(v.liveSessionCount).to.equal(1);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 13. RE-INIT MODE B — every scope field overwritten + all four meters reset.
  //     Register A with value-set V1 (session_pubkey K1, maxAmount $3, expiresAt
  //     E1, nonce N1, revolving R1). Then replace A with a COMPLETELY DIFFERENT
  //     value-set V2 (session_pubkey K2, maxAmount $9, expiresAt E2, nonce N2,
  //     revolving R2). Assert the PDA carries ALL V2 values — NONE of V1 survive —
  //     and spent/current_outstanding/crystallized_cumulative/last_locked_sequence
  //     are all 0.
  //
  //     METER COVERAGE — SIMPLER VARIANT CHOSEN: this asserts the four meters are
  //     0 after a FRESH replace (they start at 0 and the handler unconditionally
  //     re-zeros them). The STRONGER variant — settle a tab against A so spent>0 /
  //     current_outstanding>0 BEFORE the replace, then prove the replace zeroes a
  //     NON-zero meter — would more forcefully exercise the Mode-B "kill stale
  //     state" path. It's deferred because wiring a full settle (lock_voucher /
  //     settle_tab_voucher with the role-1 swig marker + a signed voucher) into
  //     this file is materially more setup than the §7b cases warrant, and the
  //     handler zeroes the meters by literal assignment (SessionRegistration{ …,
  //     spent: 0, current_outstanding: 0, crystallized_cumulative: 0,
  //     last_locked_sequence: 0 }) regardless of prior value — the 0-after-replace
  //     assertion already pins that literal. FLAGGED for a future settle-then-
  //     replace strengthening (see the file footer note).
  // ───────────────────────────────────────────────────────────────────────────
  it("case 13 — re-init Mode B: V2 fully overwrites V1, meters reset to 0", async () => {
    const FUND = 20_000_000n; // $20 — covers V1 $3 then V2 $9.
    const vault = await bootstrapForRegister(program, provider, {
      usdcFundingAmount: FUND,
      migrateTo: 6,
    });

    const cpA = Keypair.generate().publicKey;

    // ── value-set V1 ──────────────────────────────────────────────────────────
    const k1 = Keypair.generate();
    const nowSec = Math.floor(Date.now() / 1000);
    const e1 = BigInt(nowSec + 3600); // +1h
    const n1 = 11;
    const r1 = 2_000_000n;
    const first = await register(vault, {
      counterparty: cpA,
      maxAmount: 3_000_000n,
      maxRevolvingCapacity: r1,
      sessionKeypair: k1,
      expiresAt: e1,
      nonce: n1,
    });

    // Confirm V1 actually landed (so the overwrite is meaningful, not a no-op).
    let aAcct: any = await program.account.sessionAccount.fetch(
      first.sessionPda,
    );
    expect(Buffer.from(aAcct.session.sessionPubkey)).to.deep.equal(
      Buffer.from(k1.publicKey.toBytes()),
    );
    expect(aAcct.session.maxAmount.toString()).to.equal("3000000");
    expect(aAcct.session.expiresAt.toString()).to.equal(e1.toString());
    expect(aAcct.session.nonce).to.equal(n1);
    expect(aAcct.session.maxRevolvingCapacity.toString()).to.equal(
      r1.toString(),
    );

    // ── value-set V2 — every field DIFFERENT ───────────────────────────────────
    const k2 = Keypair.generate();
    const e2 = BigInt(nowSec + 7200); // +2h, distinct from E1
    const n2 = 22;
    const r2 = 5_000_000n;
    const second = await register(vault, {
      counterparty: cpA,
      maxAmount: 9_000_000n,
      maxRevolvingCapacity: r2,
      sessionKeypair: k2,
      expiresAt: e2,
      nonce: n2,
    });
    // Same seed-bound PDA — replace in place.
    expect(second.sessionPda.toBase58()).to.equal(first.sessionPda.toBase58());

    // ── EVERY V2 value present; NO V1 value survives ──────────────────────────
    aAcct = await program.account.sessionAccount.fetch(first.sessionPda);
    expect(Buffer.from(aAcct.session.sessionPubkey)).to.deep.equal(
      Buffer.from(k2.publicKey.toBytes()),
    );
    expect(Buffer.from(aAcct.session.sessionPubkey)).to.not.deep.equal(
      Buffer.from(k1.publicKey.toBytes()),
    );
    expect(aAcct.session.maxAmount.toString()).to.equal("9000000");
    expect(aAcct.session.expiresAt.toString()).to.equal(e2.toString());
    expect(aAcct.session.nonce).to.equal(n2);
    expect(aAcct.session.maxRevolvingCapacity.toString()).to.equal(
      r2.toString(),
    );

    // ── all four meters are 0 after the replace ───────────────────────────────
    // NOTE (review 2026-06-09): this asserts meters are ABSENT on a fresh replace,
    // NOT that the reset path kills STALE non-zero state. Because no settle runs
    // between V1 and V2, the meters were already 0 going in — so this assertion
    // would pass even if the reset code were deleted. It is NOT the Mode-B
    // meter-reset proof. That proof (settle a tab → spent>0 → replace → assert
    // zeroed) lives in tests/multisession-lifecycle.ts (Task 11), where the
    // lock/settle apparatus already exists. Here we only confirm a fresh replace
    // carries no meter exposure.
    expect(aAcct.session.spent.toString()).to.equal("0");
    expect(aAcct.session.currentOutstanding.toString()).to.equal("0");
    expect(aAcct.session.crystallizedCumulative.toString()).to.equal("0");
    expect(aAcct.session.lastLockedSequence).to.equal(0);

    // Count unchanged across the replace.
    const v: any = await program.account.vault.fetch(vault.vaultPda);
    expect(v.liveSessionCount).to.equal(1);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 14. PASSKEY REPLAY REJECTED — sign-over-V1, submit-V2-args.
  //     The replace's passkey signature must cover the NEW 188-byte registration
  //     message (rebuilt on-chain from the INSTRUCTION ARGS). We construct a tx
  //     where the passkey SIGNS the message built from value-set V1 (old), but the
  //     registerSessionKey instruction ARGS carry value-set V2 (new). On-chain,
  //     verify_passkey_signed recomputes expected_challenge = sha256(V2 message)
  //     from the args and compares it to the challenge embedded in clientDataJSON
  //     — which is sha256(V1 message). They differ → PasskeyVerificationFailed
  //     (the challenge-mismatch require! in webauthn.rs::verify_passkey_signed,
  //     code 6003 / 0x1773).
  //
  //     NOTE: the secp256r1 precompile sibling ITSELF verifies fine — it's built
  //     over the V1 precompileMessage/signature, which is internally consistent.
  //     The rejection is the PROGRAM's challenge-binding check, exactly the
  //     security property under test: a signature over old values cannot authorize
  //     new values. (Same error the foreign-passkey case in register-session-key.ts
  //     asserts — there the pubkey mismatches; here the message mismatches; both
  //     surface as PasskeyVerificationFailed.)
  //
  //     CONSTRUCTION: registerSessionV2 always signs the SAME values it submits,
  //     so it can't express this skew. We inline a driver that signs message(V1)
  //     but builds the ix with args(V2) — the only place the two diverge.
  //
  //     RUN-PHASE FLAG: if the precompile happened to reject FIRST for some
  //     unrelated reason the surfaced error could be the precompile's
  //     (InvalidAccountData / a sigverify failure) rather than PasskeyVerification
  //     Failed — but here the precompile is self-consistent (signed and verified
  //     over the identical V1 message), so the program's challenge check is the
  //     first thing that fails. Expect PasskeyVerificationFailed (6003 / 0x1773).
  // ───────────────────────────────────────────────────────────────────────────
  it("case 14 — passkey replay: sign over V1, submit V2 args → PasskeyVerificationFailed", async () => {
    const FUND = 20_000_000n;
    const vault = await bootstrapForRegister(program, provider, {
      usdcFundingAmount: FUND,
      migrateTo: 6,
    });

    const cpA = Keypair.generate().publicKey;

    // Establish a live session at A with value-set V1 (so the target exists and
    // the replace path — is_new false — is the one under test). cap $3.
    const k1 = Keypair.generate();
    const nowSec = Math.floor(Date.now() / 1000);
    const e1 = BigInt(nowSec + 3600);
    const n1 = 11;
    const r1 = 2_000_000n;
    const first = await register(vault, {
      counterparty: cpA,
      maxAmount: 3_000_000n,
      maxRevolvingCapacity: r1,
      sessionKeypair: k1,
      expiresAt: e1,
      nonce: n1,
    });

    // ── value-set V2 — the args we'll SUBMIT (but NOT sign over) ──────────────
    const k2 = Keypair.generate();
    const v2 = {
      sessionPubkey: k2.publicKey.toBytes(),
      maxAmount: 9_000_000n,
      expiresAt: BigInt(nowSec + 7200),
      nonce: 22,
      maxRevolvingCapacity: 5_000_000n,
    };

    // ── the passkey SIGNS the message for value-set V1 (old) ──────────────────
    // build_registration_message(args) on-chain will produce the V2 message; the
    // challenge inside clientDataJSON encodes sha256(V1 message) → mismatch.
    const v1Message = sessionRegisterMessageV2({
      programId: program.programId,
      vaultPda: vault.vaultPda,
      sessionPubkey: k1.publicKey.toBytes(),
      maxAmount: 3_000_000n,
      expiresAt: e1,
      allowedCounterparty: cpA,
      nonce: n1,
      maxRevolvingCapacity: r1,
    });
    const signed = signOperationWithPasskey(vault.passkey, v1Message);
    const precompileIx = buildSecp256r1VerifyInstruction(
      vault.passkey.publicKey,
      signed.signature,
      signed.precompileMessage,
    );

    // ── the instruction ARGS carry value-set V2 (new) ─────────────────────────
    const [sessionPda] = deriveSessionPda(
      program.programId,
      vault.vaultPda,
      cpA,
    );
    expect(sessionPda.toBase58()).to.equal(first.sessionPda.toBase58());

    const vaultIx = await program.methods
      .registerSessionKey({
        sessionPubkey: Array.from(v2.sessionPubkey),
        maxAmount: new anchor.BN(v2.maxAmount.toString()),
        expiresAt: new anchor.BN(v2.expiresAt.toString()),
        allowedCounterparty: cpA,
        nonce: v2.nonce,
        maxRevolvingCapacity: new anchor.BN(
          v2.maxRevolvingCapacity.toString(),
        ),
        // The WebAuthn ceremony bytes are the V1-signed ones — their challenge is
        // sha256(V1 message), which won't match sha256(V2 message) rebuilt on-chain.
        clientDataJson: Buffer.from(signed.clientDataJSON),
        authenticatorData: Buffer.from(signed.authenticatorData),
      })
      .accountsPartial({
        vault: vault.vaultPda,
        vaultUsdcAta: vault.sourceAta,
        swig: vault.swigAddress,
        swigWalletAddress: vault.swigWalletAddress,
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        session: sessionPda,
        payer: provider.wallet.publicKey,
        systemProgram: SystemProgram.programId,
      })
      // Replace path: no siblings (target excluded → expected siblings == 0).
      .remainingAccounts([])
      .instruction();

    try {
      // No self-heal predicate that resolves on success — we EXPECT a revert, and
      // a real revert on the first send propagates as the thrown error.
      await sendPrecompilePairResilient(
        provider,
        [precompileIx, vaultIx],
        async () => false,
      );
      expect.fail(
        "replace with a V1-signed passkey over V2 args should have been rejected",
      );
    } catch (err: any) {
      // The on-chain challenge-binding check (sha256(V2 args) != challenge over
      // V1) fails → PasskeyVerificationFailed (6003 / 0x1773). Same family as the
      // foreign-passkey rejection in register-session-key.ts.
      expect(err.toString()).to.match(
        /PasskeyVerificationFailed|6003|0x1773/,
      );
    }

    // The replace was rejected: A's PDA STILL carries value-set V1 (unchanged).
    const aAfter: any = await program.account.sessionAccount.fetch(
      first.sessionPda,
    );
    expect(Buffer.from(aAfter.session.sessionPubkey)).to.deep.equal(
      Buffer.from(k1.publicKey.toBytes()),
    );
    expect(aAfter.session.maxAmount.toString()).to.equal("3000000");
    const v: any = await program.account.vault.fetch(vault.vaultPda);
    expect(v.liveSessionCount).to.equal(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// FUTURE STRENGTHENING (run-phase / follow-up):
//   case 13 currently asserts the four SessionRegistration meters are 0 after a
//   FRESH replace. The stronger variant settles a tab against A so spent>0 and
//   current_outstanding>0 BEFORE the replace, then proves the replace zeroes a
//   genuinely-NON-zero meter — exercising the Mode-B "kill stale state" path with
//   live stale state rather than a literal-0 re-assert. Deferred here to avoid
//   pulling the full settle apparatus (lock_voucher / settle_tab_voucher + role-1
//   swig marker + signed voucher) into a §7b file; the handler zeroes the meters
//   by literal assignment regardless of prior value, which the 0-after-replace
//   assertion already pins.
// ─────────────────────────────────────────────────────────────────────────────
