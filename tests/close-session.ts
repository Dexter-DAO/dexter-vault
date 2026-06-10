// V6 `close_session` — reclaim the rent parked in a CLEARED session PDA.
//
// ────────────────────────────────────────────────────────────────────────────
// RUN CONTEXT
//   Runs against deployed-V6-on-mainnet; gated on the V6 deploy + Helius RPC.
//   Registration/revocation use the mainnet secp256r1 precompile (SIMD-0075),
//   so this is a MAINNET integration test driven through `makeTestProvider`
//   (ANCHOR_PROVIDER_URL / ANCHOR_WALLET). It is WRITE-ONLY at authoring time —
//   type-checked but NOT executed; it runs as part of the gated post-deploy V6
//   suite alongside multisession-lifecycle.ts.
// ────────────────────────────────────────────────────────────────────────────
//
// WHAT THIS PROVES
//   revoke_session_key CLEARs a session PDA (version→0, fields zeroed,
//   live_session_count--) but never closes it — the rent (~0.0021 SOL) parks
//   forever per revoked tab (spec §5 CLEAR-not-CLOSE: same-tx close+refund is
//   the sealevel revival window). close_session is the deferred janitor:
//   authority-gated, cleared-only, rent → dexter_authority, and — per Anchor
//   0.32.1 close semantics — the account ends lamports-0 / data-len-0 /
//   System-Program-owned, i.e. GONE.
//
//     1  register → revoke → close: rent lands on dexter_authority (exact
//        delta = session rent − tx fee when the fee is fetchable, bounded
//        otherwise), account no longer exists (getAccountInfo null)
//     2  close a LIVE session → SessionStillLive (revoke first)
//     3  close with a wrong authority signer → has_one constraint rejects
//     4  close with a wrong counterparty → (a) no PDA at the derived address
//        (AccountNotInitialized) and (b) real PDA + mismatched arg
//        (ConstraintSeeds)
//     5  register → revoke → close → REGISTER AGAIN same counterparty →
//        fresh PDA via init_if_needed (version V1, meters zero, payer funds
//        rent again, live_session_count increments normally)
//     6  sibling interplay: live A + cleared-then-CLOSED B → registering C
//        passes ONLY sibling A (B's PDA is gone, so it cannot — and need not —
//        be passed) → succeeds, count correct
//
// ASSERTION SHAPE
//   Positive cases assert via getAccountInfo (closed = null) + lamport deltas
//   + sessionAccount.fetch / vault.fetch field asserts. Negative cases drive
//   the revert and match the AnchorError name/code via
//   expect(err.toString()).to.match(), identical to the sibling V6 files.

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { DexterVault } from "../target/types/dexter_vault";
import {
  Keypair,
  PublicKey,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  TransactionInstruction,
} from "@solana/web3.js";
import { expect } from "chai";

import {
  signOperationWithPasskey,
  buildSecp256r1VerifyInstruction,
  makeTestProvider,
  sendPrecompilePairResilient,
  sendAndConfirmWithRetry,
  isTransientDropError,
  sessionRevokeMessage,
  pollUntilAccount,
} from "./helpers/secp256r1";
import {
  bootstrapForRegister,
  registerSessionV2,
  RegisterReadyVault,
} from "./helpers/register-bootstrap";
import { deriveSessionPda } from "./helpers/session";

describe("V6 close_session — reclaim cleared session-PDA rent (0.5-T3)", () => {
  const provider = makeTestProvider();
  const workspaceProgram = anchor.workspace.DexterVault as Program<DexterVault>;
  const program = new anchor.Program<DexterVault>(workspaceProgram.idl, provider);

  // bootstrapForRegister inits every vault with dexter_authority = the provider
  // wallet, so the provider wallet is BOTH the close_session signer AND the
  // rent recipient (and the fee payer — the delta assertions account for that).
  const authority = provider.wallet.publicKey;

  // ── Revoke driver (same shape as multisession-lifecycle.ts::revokeV6): the
  //    passkey signs the 128-byte revocation message binding the SPECIFIC
  //    session_pubkey on the PDA; [precompile, revoke] resilient pair; then
  //    ALWAYS wait until the clear (version == 0) is replica-visible. ─────────
  async function revokeV6(
    vault: RegisterReadyVault,
    counterparty: PublicKey,
    sessionPubkey: Uint8Array,
  ): Promise<void> {
    const [sessionPda] = deriveSessionPda(
      program.programId,
      vault.vaultPda,
      counterparty,
    );
    const msg = sessionRevokeMessage({
      programId: program.programId,
      vaultPda: vault.vaultPda,
      sessionPubkey,
    });
    const signed = signOperationWithPasskey(vault.passkey, msg);
    const precompileIx = buildSecp256r1VerifyInstruction(
      vault.passkey.publicKey,
      signed.signature,
      signed.precompileMessage,
    );
    const revokeIx = await program.methods
      .revokeSessionKey({
        allowedCounterparty: counterparty,
        clientDataJson: Buffer.from(signed.clientDataJSON),
        authenticatorData: Buffer.from(signed.authenticatorData),
      })
      .accountsPartial({
        vault: vault.vaultPda,
        session: sessionPda,
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .instruction();
    await sendPrecompilePairResilient(
      provider,
      [precompileIx, revokeIx],
      async () => {
        const s: any = await program.account.sessionAccount
          .fetch(sessionPda)
          .catch(() => null);
        return !!s && s.version === 0;
      },
    );
    await pollUntilAccount(
      () => program.account.sessionAccount.fetch(sessionPda),
      (s: any) => s.version === 0,
    );
  }

  // Build the close_session instruction (no precompile sibling — the authority
  // Signer is the whole authorization surface).
  async function buildCloseIx(
    vaultPda: PublicKey,
    counterparty: PublicKey,
    sessionPda: PublicKey,
    dexterAuthority: PublicKey,
  ): Promise<TransactionInstruction> {
    return await program.methods
      .closeSession({ allowedCounterparty: counterparty })
      .accountsPartial({
        vault: vaultPda,
        session: sessionPda,
        dexterAuthority,
      })
      .instruction();
  }

  // Send a close_session and wait until the PDA is GONE (getAccountInfo null).
  // close is NOT idempotent (a resend of a dropped-but-landed close reverts
  // AccountNotInitialized), so on a transient-drop error we self-heal by
  // checking the RESULT instead of blind-resending. Returns the signature when
  // the happy-path send produced one ("" on the self-heal path).
  async function closeV6(
    vault: RegisterReadyVault,
    counterparty: PublicKey,
  ): Promise<string> {
    const [sessionPda] = deriveSessionPda(
      program.programId,
      vault.vaultPda,
      counterparty,
    );
    const closeIx = await buildCloseIx(
      vault.vaultPda,
      counterparty,
      sessionPda,
      authority,
    );
    let sig = "";
    try {
      sig = await sendAndConfirmWithRetry(provider, [closeIx]);
    } catch (err: any) {
      // A transient drop may still have landed; the closed-account check below
      // is the source of truth. A program revert propagates.
      if (!isTransientDropError(err)) throw err;
    }
    // CONFIRM-VISIBILITY: wait until the close is replica-visible (account
    // gone). Anchor 0.32.1 close leaves the account lamports-0 / data-0 /
    // System-owned, which the runtime garbage-collects → getAccountInfo null.
    await pollUntilAccount(
      () => provider.connection.getAccountInfo(sessionPda, "confirmed"),
      (info) => info === null,
    );
    return sig;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Cases 1 + 5 share one vault: the chain register → revoke → CLOSE (case 1)
  // → REGISTER AGAIN same counterparty (case 5) is one continuous lifecycle.
  // ───────────────────────────────────────────────────────────────────────────
  describe("reclaim + re-register lifecycle (cases 1, 5)", () => {
    let vault: RegisterReadyVault;
    let counterparty: PublicKey;
    let sessionPda: PublicKey;

    it("case 1 — register → revoke → close: rent lands on dexter_authority, PDA gone", async function () {
      this.timeout(600_000);

      vault = await bootstrapForRegister(program, provider, {
        usdcFundingAmount: 10_000_000n,
        migrateTo: 6,
      });
      counterparty = Keypair.generate().publicKey;
      const reg = await registerSessionV2(program, provider, {
        vaultPda: vault.vaultPda,
        passkey: vault.passkey,
        vaultUsdcAta: vault.sourceAta,
        swigAddress: vault.swigAddress,
        swigWalletAddress: vault.swigWalletAddress,
        maxAmount: 3_000_000n,
        maxRevolvingCapacity: 3_000_000n,
        allowedCounterparty: counterparty,
      });
      sessionPda = reg.sessionPda;

      // REVOKE → cleared (version 0), count back to 0, rent still parked.
      const live: any = await program.account.sessionAccount.fetch(sessionPda);
      await revokeV6(
        vault,
        counterparty,
        Uint8Array.from(live.session.sessionPubkey),
      );
      const clearedAi = await provider.connection.getAccountInfo(sessionPda);
      expect(clearedAi, "cleared PDA must still exist before close").to.not.be
        .null;
      const sessionRent = clearedAi!.lamports; // the parked rent we reclaim
      expect(sessionRent).to.be.greaterThan(0);
      let v: any = await program.account.vault.fetch(vault.vaultPda);
      expect(v.liveSessionCount).to.equal(0);

      // ── CLOSE ──
      const authorityBefore = await provider.connection.getBalance(
        authority,
        "confirmed",
      );
      const sig = await closeV6(vault, counterparty);

      // PDA GONE (Anchor close: lamports drained, data resized to 0, owner →
      // System Program; the runtime reaps the 0-lamport account).
      const postAi = await provider.connection.getAccountInfo(sessionPda);
      expect(postAi, "close_session must remove the PDA").to.be.null;

      // RENT LANDED on dexter_authority. The authority is also the fee payer,
      // so the observed delta is (sessionRent − txFee). When the happy-path
      // signature is available we fetch the EXACT fee from the tx meta and
      // assert equality; on the (rare) self-heal path we fall back to a
      // bounded assertion — the delta must recover almost all of the rent
      // (fee is ~5k–100k lamports vs ~2.1M lamports of rent).
      const authorityAfter = await provider.connection.getBalance(
        authority,
        "confirmed",
      );
      const delta = authorityAfter - authorityBefore;
      let exactFee: number | null = null;
      if (sig) {
        const tx = await provider.connection
          .getTransaction(sig, {
            commitment: "confirmed",
            maxSupportedTransactionVersion: 0,
          })
          .catch(() => null);
        if (tx?.meta?.fee !== undefined) exactFee = tx.meta.fee;
      }
      if (exactFee !== null) {
        expect(delta).to.equal(sessionRent - exactFee);
      } else {
        expect(delta).to.be.greaterThan(sessionRent - 200_000); // rent minus a generous fee bound
        expect(delta).to.be.at.most(sessionRent);
      }
      // Count untouched by close (the decrement already happened at revoke).
      v = await program.account.vault.fetch(vault.vaultPda);
      expect(v.liveSessionCount).to.equal(0);
    });

    it("case 5 — REGISTER AGAIN after close: fresh PDA via init_if_needed (version V1, meters zero, count correct)", async function () {
      this.timeout(600_000);

      // Pre-state from case 1: PDA gone, count 0. The payer (provider wallet)
      // funds the rent AGAIN — assert the recreated account actually carries
      // rent (init_if_needed ran its CREATE path, not a replace).
      const fresh = await registerSessionV2(program, provider, {
        vaultPda: vault.vaultPda,
        passkey: vault.passkey,
        vaultUsdcAta: vault.sourceAta,
        swigAddress: vault.swigAddress,
        swigWalletAddress: vault.swigWalletAddress,
        maxAmount: 4_000_000n,
        maxRevolvingCapacity: 4_000_000n,
        allowedCounterparty: counterparty,
        siblings: [], // count is 0 going in → 0 expected siblings
      });
      // Same seed-bound address, brand-new account.
      expect(fresh.sessionPda.toBase58()).to.equal(sessionPda.toBase58());

      const ai = await provider.connection.getAccountInfo(sessionPda);
      expect(ai, "re-register must recreate the PDA").to.not.be.null;
      expect(ai!.lamports).to.be.greaterThan(0); // payer funded rent again
      expect(ai!.owner.toBase58()).to.equal(program.programId.toBase58());

      const s: any = await program.account.sessionAccount.fetch(sessionPda);
      expect(s.version).to.equal(1); // SESSION_VERSION_V1 — first-touch path
      expect(s.session.maxAmount.toString()).to.equal("4000000");
      expect(Buffer.from(s.session.sessionPubkey)).to.deep.equal(
        Buffer.from(fresh.sessionKeypair.publicKey.toBytes()),
      );
      // Meters zero on a fresh registration.
      expect(s.session.spent.toString()).to.equal("0");
      expect(s.session.currentOutstanding.toString()).to.equal("0");
      expect(s.session.crystallizedCumulative.toString()).to.equal("0");
      expect(s.session.lastLockedSequence).to.equal(0);

      // first-touch increment: count back to 1.
      const v: any = await program.account.vault.fetch(vault.vaultPda);
      expect(v.liveSessionCount).to.equal(1);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Cases 2, 3, 4 share one vault with one LIVE session — every case here is a
  // rejected close that leaves the session intact, so they can't poison each
  // other. Order-independent.
  // ───────────────────────────────────────────────────────────────────────────
  describe("rejected closes (cases 2, 3, 4)", () => {
    let vault: RegisterReadyVault;
    let counterparty: PublicKey;
    let sessionPda: PublicKey;

    before(async function () {
      this.timeout(600_000);
      vault = await bootstrapForRegister(program, provider, {
        usdcFundingAmount: 10_000_000n,
        migrateTo: 6,
      });
      counterparty = Keypair.generate().publicKey;
      const reg = await registerSessionV2(program, provider, {
        vaultPda: vault.vaultPda,
        passkey: vault.passkey,
        vaultUsdcAta: vault.sourceAta,
        swigAddress: vault.swigAddress,
        swigWalletAddress: vault.swigWalletAddress,
        maxAmount: 3_000_000n,
        maxRevolvingCapacity: 3_000_000n,
        allowedCounterparty: counterparty,
      });
      sessionPda = reg.sessionPda;
    });

    it("case 2 — close a LIVE session → SessionStillLive (revoke first)", async function () {
      this.timeout(600_000);

      let threw = false;
      try {
        await program.methods
          .closeSession({ allowedCounterparty: counterparty })
          .accountsPartial({
            vault: vault.vaultPda,
            session: sessionPda,
            dexterAuthority: authority,
          })
          .rpc();
      } catch (err: any) {
        threw = true;
        expect(err.toString()).to.match(/SessionStillLive/);
      }
      expect(threw, "closing a live session must revert").to.equal(true);

      // Session untouched: still live, still on-chain, count still 1.
      const s: any = await program.account.sessionAccount.fetch(sessionPda);
      expect(s.version).to.not.equal(0);
      const v: any = await program.account.vault.fetch(vault.vaultPda);
      expect(v.liveSessionCount).to.equal(1);
    });

    it("case 3 — wrong authority signer → has_one constraint rejects", async function () {
      this.timeout(600_000);

      // The attacker signs as dexter_authority (the struct's Signer type makes
      // them actually sign), but vault.dexter_authority is the provider wallet
      // → ConstraintHasOne, mapped to PasskeyVerificationFailed (the same
      // authority-gate error settle_voucher uses). Fee payer stays the
      // provider wallet, so the attacker needs no lamports.
      const attacker = Keypair.generate();
      let threw = false;
      try {
        await program.methods
          .closeSession({ allowedCounterparty: counterparty })
          .accountsPartial({
            vault: vault.vaultPda,
            session: sessionPda,
            dexterAuthority: attacker.publicKey,
          })
          .signers([attacker])
          .rpc();
      } catch (err: any) {
        threw = true;
        expect(err.toString()).to.match(
          /PasskeyVerificationFailed|ConstraintHasOne|2001/,
        );
      }
      expect(threw, "wrong authority must be rejected").to.equal(true);

      // Session untouched.
      const ai = await provider.connection.getAccountInfo(sessionPda);
      expect(ai).to.not.be.null;
    });

    it("case 4 — wrong counterparty: no such PDA / PDA mismatch → fails", async function () {
      this.timeout(600_000);

      const wrongCounterparty = Keypair.generate().publicKey;

      // (a) Honest derivation for the wrong counterparty: the canonical PDA at
      //     [SESSION_SEED, vault, wrongCounterparty] was never created, so
      //     Account<SessionAccount> deserialization fails AccountNotInitialized.
      const [wrongPda] = deriveSessionPda(
        program.programId,
        vault.vaultPda,
        wrongCounterparty,
      );
      let threwA = false;
      try {
        await program.methods
          .closeSession({ allowedCounterparty: wrongCounterparty })
          .accountsPartial({
            vault: vault.vaultPda,
            session: wrongPda,
            dexterAuthority: authority,
          })
          .rpc();
      } catch (err: any) {
        threwA = true;
        expect(err.toString()).to.match(/AccountNotInitialized|3012/);
      }
      expect(threwA, "close against a never-created PDA must revert").to.equal(
        true,
      );

      // (b) Mismatch: the REAL session account with a wrong counterparty arg —
      //     the seeds constraint re-derives [.., wrongCounterparty] which does
      //     not produce sessionPda → ConstraintSeeds. This is the gate that
      //     makes the args-based seed binding sound: you cannot point the
      //     accounts at one session while naming another.
      let threwB = false;
      try {
        await program.methods
          .closeSession({ allowedCounterparty: wrongCounterparty })
          .accountsPartial({
            vault: vault.vaultPda,
            session: sessionPda, // real PDA, mismatched arg
            dexterAuthority: authority,
          })
          .rpc();
      } catch (err: any) {
        threwB = true;
        expect(err.toString()).to.match(/ConstraintSeeds|2006/);
      }
      expect(threwB, "mismatched counterparty arg must revert").to.equal(true);

      // The real session is untouched by both attempts.
      const s: any = await program.account.sessionAccount.fetch(sessionPda);
      expect(s.version).to.not.equal(0);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 6. SIBLING INTERPLAY — the register-gate completeness contract survives a
  //    close. Live A + cleared-then-CLOSED B → registering C passes ONLY
  //    sibling A: B's PDA no longer exists (gPA wouldn't return it; there is
  //    nothing to pass), and the completeness equation
  //    (total_passed == live_session_count − is_new_adjustment) already
  //    excluded B at revoke time. count: A(1) +B(2) −revokeB(1) =closeB(1)
  //    +C(2).
  // ───────────────────────────────────────────────────────────────────────────
  it("case 6 — live A + closed B: registering C passes only sibling A → succeeds, count correct", async function () {
    this.timeout(600_000);

    const vault = await bootstrapForRegister(program, provider, {
      usdcFundingAmount: 20_000_000n, // headroom for A + C live caps
      migrateTo: 6,
    });

    // Register A (live, stays live throughout).
    const cpA = Keypair.generate().publicKey;
    const a = await registerSessionV2(program, provider, {
      vaultPda: vault.vaultPda,
      passkey: vault.passkey,
      vaultUsdcAta: vault.sourceAta,
      swigAddress: vault.swigAddress,
      swigWalletAddress: vault.swigWalletAddress,
      maxAmount: 3_000_000n,
      maxRevolvingCapacity: 3_000_000n,
      allowedCounterparty: cpA,
    });

    // Register B (passing sibling A), then revoke + CLOSE it.
    const cpB = Keypair.generate().publicKey;
    const b = await registerSessionV2(program, provider, {
      vaultPda: vault.vaultPda,
      passkey: vault.passkey,
      vaultUsdcAta: vault.sourceAta,
      swigAddress: vault.swigAddress,
      swigWalletAddress: vault.swigWalletAddress,
      maxAmount: 2_000_000n,
      maxRevolvingCapacity: 2_000_000n,
      allowedCounterparty: cpB,
      siblings: [{ pubkey: a.sessionPda }],
    });
    let v: any = await program.account.vault.fetch(vault.vaultPda);
    expect(v.liveSessionCount).to.equal(2);

    const bLive: any = await program.account.sessionAccount.fetch(b.sessionPda);
    await revokeV6(vault, cpB, Uint8Array.from(bLive.session.sessionPubkey));
    await closeV6(vault, cpB);

    // B is GONE; A still live; count 1.
    expect(await provider.connection.getAccountInfo(b.sessionPda)).to.be.null;
    v = await program.account.vault.fetch(vault.vaultPda);
    expect(v.liveSessionCount).to.equal(1);

    // Register C passing ONLY sibling A. Completeness: C is new →
    // expected_total = live_session_count(1) − 0 = 1, and we pass exactly the
    // one live sibling A. B's closed PDA cannot be passed (it doesn't exist) —
    // and the gate never asks for it.
    const cpC = Keypair.generate().publicKey;
    const c = await registerSessionV2(program, provider, {
      vaultPda: vault.vaultPda,
      passkey: vault.passkey,
      vaultUsdcAta: vault.sourceAta,
      swigAddress: vault.swigAddress,
      swigWalletAddress: vault.swigWalletAddress,
      maxAmount: 4_000_000n,
      maxRevolvingCapacity: 4_000_000n,
      allowedCounterparty: cpC,
      siblings: [{ pubkey: a.sessionPda }],
    });

    const cAcct: any = await program.account.sessionAccount.fetch(c.sessionPda);
    expect(cAcct.version).to.not.equal(0);
    expect(cAcct.session.maxAmount.toString()).to.equal("4000000");
    v = await program.account.vault.fetch(vault.vaultPda);
    expect(v.liveSessionCount).to.equal(2); // A + C live; B fully gone
  });
});
