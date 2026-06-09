// V6 multi-session overcommit gate — ADVERSARIAL MATRIX (spec §7a, cases 1-11 + 23).
//
// ────────────────────────────────────────────────────────────────────────────
// RUN CONTEXT
//   Runs against deployed-V6-on-mainnet; gated on the V6 deploy + Helius RPC.
//   The passkey path uses the mainnet secp256r1 precompile (SIMD-0075), so this
//   is a MAINNET integration test driven through `makeTestProvider`
//   (ANCHOR_PROVIDER_URL / ANCHOR_WALLET). It is WRITE-ONLY at authoring time —
//   it was type-checked but NOT executed (Helius was down). It will run as part
//   of the post-deploy V6 suite.
// ────────────────────────────────────────────────────────────────────────────
//
// WHAT THIS PROVES
//   register_session_key's overcommit gate (handler step C) is un-gameable.
//   Sessions live in per-counterparty `SessionAccount` PDAs derived at
//   [SESSION_SEED, vault, allowed_counterparty]. Registering a session requires
//   the caller to pass EVERY OTHER sibling (live AND expired) in
//   remaining_accounts. The gate enforces, per sibling:
//     (i)   strict-ascending pubkey order  → dedup + canonical order in one check
//     (ii)  target-not-in-set              → the new session's own PDA is excluded
//     (iii) owner + 8-byte discriminator   → Account::try_from
//     (iv)  vault-bind + PDA re-derive     → create_program_address via stored bump
//     (v)   live/expired partition         → SUM live caps; SWEEP (clear) expired
//     (vi)  completeness                   → live+swept == live_session_count − (is_new?0:1)
//     (vii) overcommit invariant           → Σlive + new_cap + outstanding_locked ≤ ATA
//   plus an E.0 count re-sync (subtract swept) and the first-touch increment.
//
//   Each negative case below drives the gate to a SPECIFIC revert and asserts on
//   the Anchor error NAME (the harness surfaces the error name in err.toString();
//   register-session-overcommit.ts uses the same `.match(/Name/)` pattern).
//
// ASSERTION SHAPE
//   A reverted Anchor tx throws; the thrown error's toString() contains the
//   AnchorError name (e.g. "SessionAccountsNotSorted"). We assert via
//   expect(err.toString()).to.match(/Name/) — identical to the V5 overcommit
//   test. Error CODES (from target/idl/dexter_vault.json) for reference:
//     SessionWouldOvercommitVault 6018 · SessionAccountsNotSorted 6019 ·
//     SessionAccountForeign 6020 · SessionAccountMisderived 6021 ·
//     IncompleteSessionSet 6022 · SessionCountAtMax 6023 ·
//     SessionAccountNotWritable 6038.

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { DexterVault } from "../target/types/dexter_vault";
import {
  AccountMeta,
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
import {
  deriveSessionPda,
  sortSessionAccounts,
} from "./helpers/session";

// ── Low-level register driver ────────────────────────────────────────────────
// registerSessionV2 (the helper) ALWAYS routes its siblings through
// siblingRemainingAccounts, which SORTS them strict-ascending. That's exactly
// what the positive cases want — but the adversarial ORDERING/SET cases
// (duplicate, out-of-order, foreign, misderived, target-in-set, count-mismatch)
// need to inject a HAND-CRAFTED remaining_accounts list the helper would
// otherwise "fix". This driver mirrors registerSessionV2's passkey ceremony but
// takes a raw AccountMeta[] verbatim, so the test controls order + writability.
//
// It returns the sessionPda (so positive assertions can fetch it) and the tx
// signature. It deliberately does NOT poll-self-heal: the negative cases EXPECT
// a revert, and we want that revert to propagate as the thrown error.
async function registerRaw(
  program: Program<DexterVault>,
  provider: anchor.AnchorProvider,
  opts: {
    vaultPda: PublicKey;
    passkey: RegisterReadyVault["passkey"];
    vaultUsdcAta: PublicKey;
    swigAddress: PublicKey;
    swigWalletAddress: PublicKey;
    maxAmount: bigint;
    maxRevolvingCapacity: bigint;
    allowedCounterparty: PublicKey;
    expiresAt?: bigint;
    nonce?: number;
    sessionKeypair?: Keypair;
    /** Raw remaining_accounts, passed VERBATIM (no sort, no writability fixup).
     *  This is the whole point of registerRaw — the negative cases craft this. */
    remaining: AccountMeta[];
  },
): Promise<{ signature: string; sessionPda: PublicKey }> {
  const sessionKeypair = opts.sessionKeypair ?? Keypair.generate();
  const sessionPubkey = sessionKeypair.publicKey.toBytes();
  const expiresAt =
    opts.expiresAt ?? BigInt(Math.floor(Date.now() / 1000) + 3600);
  const nonce = opts.nonce ?? 1;

  const [sessionPda] = deriveSessionPda(
    program.programId,
    opts.vaultPda,
    opts.allowedCounterparty,
  );

  const msg = sessionRegisterMessageV2({
    programId: program.programId,
    vaultPda: opts.vaultPda,
    sessionPubkey,
    maxAmount: opts.maxAmount,
    expiresAt,
    allowedCounterparty: opts.allowedCounterparty,
    nonce,
    maxRevolvingCapacity: opts.maxRevolvingCapacity,
  });
  const signed = signOperationWithPasskey(opts.passkey, msg);
  const precompileIx = buildSecp256r1VerifyInstruction(
    opts.passkey.publicKey,
    signed.signature,
    signed.precompileMessage,
  );
  const vaultIx = await program.methods
    .registerSessionKey({
      sessionPubkey: Array.from(sessionPubkey),
      maxAmount: new anchor.BN(opts.maxAmount.toString()),
      expiresAt: new anchor.BN(expiresAt.toString()),
      allowedCounterparty: opts.allowedCounterparty,
      nonce,
      maxRevolvingCapacity: new anchor.BN(opts.maxRevolvingCapacity.toString()),
      clientDataJson: Buffer.from(signed.clientDataJSON),
      authenticatorData: Buffer.from(signed.authenticatorData),
    })
    .accountsPartial({
      vault: opts.vaultPda,
      vaultUsdcAta: opts.vaultUsdcAta,
      swig: opts.swigAddress,
      swigWalletAddress: opts.swigWalletAddress,
      instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
      session: sessionPda,
      payer: provider.wallet.publicKey,
      systemProgram: SystemProgram.programId,
    })
    .remainingAccounts(opts.remaining)
    .instruction();

  // Negative cases EXPECT this to revert. Use the resilient pair send for the
  // positive raw cases, but a real revert on the first send propagates as the
  // thrown error (sendPrecompilePairResilient only self-heals a TRANSIENT drop,
  // not a program revert). We supply a predicate that confirms the session PDA
  // exists with version != 0 so the rare drop-then-landed path still resolves.
  const sig = await sendPrecompilePairResilient(
    provider,
    [precompileIx, vaultIx],
    async () => {
      const s: any = await program.account.sessionAccount
        .fetch(sessionPda)
        .catch(() => null);
      return !!s && s.version !== 0;
    },
  );
  return { signature: sig ?? "", sessionPda };
}

/** A live SessionAccount AccountMeta, read-only (the gate keeps live siblings
 *  read-only). */
function liveMeta(pubkey: PublicKey): AccountMeta {
  return { pubkey, isSigner: false, isWritable: false };
}

/** An expired SessionAccount AccountMeta, WRITABLE (the on-chain sweep clears it,
 *  which requires writability — a read-only expired sibling reverts with
 *  SessionAccountNotWritable). */
function expiredMeta(pubkey: PublicKey): AccountMeta {
  return { pubkey, isSigner: false, isWritable: true };
}

describe("register_session_key — V6 multi-session overcommit gate (spec §7a)", () => {
  const provider = makeTestProvider();
  const workspaceProgram = anchor.workspace.DexterVault as Program<DexterVault>;
  const program = new anchor.Program<DexterVault>(
    workspaceProgram.idl,
    provider,
  );

  // Helper: register session A (no siblings) on a fresh counterparty PDA.
  async function registerA(
    vault: RegisterReadyVault,
    cap: bigint,
    counterparty: PublicKey,
    opts: { expiresAt?: bigint; nonce?: number } = {},
  ) {
    return registerSessionV2(program, provider, {
      vaultPda: vault.vaultPda,
      passkey: vault.passkey,
      vaultUsdcAta: vault.sourceAta,
      swigAddress: vault.swigAddress,
      swigWalletAddress: vault.swigWalletAddress,
      maxAmount: cap,
      maxRevolvingCapacity: cap,
      allowedCounterparty: counterparty,
      expiresAt: opts.expiresAt,
      nonce: opts.nonce,
    });
  }

  // ───────────────────────────────────────────────────────────────────────────
  // 11. HAPPY PATH — two sessions, both PDAs on-chain, live_session_count == 2.
  // ───────────────────────────────────────────────────────────────────────────
  it("case 11 — happy path: register A then B (passing [A]) → both live, count==2", async () => {
    const FUND = 10_000_000n; // $10 — comfortably covers 3 + 4.
    const vault = await bootstrapForRegister(program, provider, {
      usdcFundingAmount: FUND,
      migrateTo: 6,
    });

    const cpA = Keypair.generate().publicKey;
    const cpB = Keypair.generate().publicKey;

    // A: cap $3, no siblings → live_session_count = 1.
    const a = await registerA(vault, 3_000_000n, cpA);
    const aAcct: any = await program.account.sessionAccount.fetch(a.sessionPda);
    expect(aAcct.session.maxAmount.toString()).to.equal("3000000");
    let v: any = await program.account.vault.fetch(vault.vaultPda);
    expect(v.liveSessionCount).to.equal(1);

    // B: cap $4, passing [A] as the sole live sibling → count = 2.
    const b = await registerSessionV2(program, provider, {
      vaultPda: vault.vaultPda,
      passkey: vault.passkey,
      vaultUsdcAta: vault.sourceAta,
      swigAddress: vault.swigAddress,
      swigWalletAddress: vault.swigWalletAddress,
      maxAmount: 4_000_000n,
      maxRevolvingCapacity: 4_000_000n,
      allowedCounterparty: cpB,
      siblings: [{ pubkey: a.sessionPda }],
    });

    const bAcct: any = await program.account.sessionAccount.fetch(b.sessionPda);
    expect(bAcct.session.maxAmount.toString()).to.equal("4000000");
    v = await program.account.vault.fetch(vault.vaultPda);
    expect(v.liveSessionCount).to.equal(2);
    // Both PDAs exist and are distinct.
    expect(a.sessionPda.toBase58()).to.not.equal(b.sessionPda.toBase58());
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 10. GENUINE OVERCOMMIT — 3 + 3 = 6 > $5 funded → SessionWouldOvercommitVault.
  // ───────────────────────────────────────────────────────────────────────────
  it("case 10 — genuine overcommit: A($3) + B($3) over $5 vault → SessionWouldOvercommitVault", async () => {
    const FUND = 5_000_000n; // $5 — 3 + 3 = 6 exceeds it.
    const vault = await bootstrapForRegister(program, provider, {
      usdcFundingAmount: FUND,
      migrateTo: 6,
    });

    const cpA = Keypair.generate().publicKey;
    const cpB = Keypair.generate().publicKey;

    const a = await registerA(vault, 3_000_000n, cpA);

    try {
      await registerSessionV2(program, provider, {
        vaultPda: vault.vaultPda,
        passkey: vault.passkey,
        vaultUsdcAta: vault.sourceAta,
        swigAddress: vault.swigAddress,
        swigWalletAddress: vault.swigWalletAddress,
        maxAmount: 3_000_000n,
        maxRevolvingCapacity: 3_000_000n,
        allowedCounterparty: cpB,
        siblings: [{ pubkey: a.sessionPda }],
      });
      expect.fail("expected SessionWouldOvercommitVault");
    } catch (err: any) {
      expect(err.toString()).to.match(/SessionWouldOvercommitVault/);
    }
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 9. AT-MAX — live_session_count < 255 require.
  //    Registering 255 real sessions on mainnet is prohibitively slow/expensive
  //    (255 passkey ceremonies + 255 init_if_needed rents + an O(n²) sibling
  //    blow-up as each register passes all prior siblings). The boundary is a
  //    single `require!(live_session_count < 255, SessionCountAtMax)` at the top
  //    of the gate (register_session_key.rs ~line 157) — best covered by a Rust
  //    unit test that pokes a vault account with live_session_count = 255 and
  //    asserts the require fires, NOT by a live-chain fixture. Skipped here with
  //    that rationale; flagged for a future #[test] in the program crate.
  // ───────────────────────────────────────────────────────────────────────────
  it.skip("case 9 — at-max (255): SessionCountAtMax [covered by code review + future Rust unit test]", async () => {
    // Intentionally empty. See the block comment above: forcing
    // live_session_count == 255 on mainnet is impractical; the boundary is a
    // pure scalar require best exercised by a program-crate unit test.
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 1. OMIT-A-SIBLING — A live, register B with [] → IncompleteSessionSet.
  //    (live_counted+swept = 0, expected_total = live_session_count − 0 = 1.)
  // ───────────────────────────────────────────────────────────────────────────
  it("case 1 — omit a sibling: A live, B passes [] → IncompleteSessionSet", async () => {
    const vault = await bootstrapForRegister(program, provider, {
      usdcFundingAmount: 10_000_000n,
      migrateTo: 6,
    });
    const cpA = Keypair.generate().publicKey;
    const cpB = Keypair.generate().publicKey;

    await registerA(vault, 3_000_000n, cpA);

    try {
      // Pass NO siblings even though A is live → completeness check (vi) fails.
      await registerSessionV2(program, provider, {
        vaultPda: vault.vaultPda,
        passkey: vault.passkey,
        vaultUsdcAta: vault.sourceAta,
        swigAddress: vault.swigAddress,
        swigWalletAddress: vault.swigWalletAddress,
        maxAmount: 1_000_000n,
        maxRevolvingCapacity: 1_000_000n,
        allowedCounterparty: cpB,
        siblings: [],
      });
      expect.fail("expected IncompleteSessionSet");
    } catch (err: any) {
      expect(err.toString()).to.match(/IncompleteSessionSet/);
    }
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 2. FOREIGN ACCOUNT — a SessionAccount from a DIFFERENT vault as a sibling.
  //    vault-bind check (iv): sib.vault != this vault → SessionAccountForeign.
  // ───────────────────────────────────────────────────────────────────────────
  it("case 2 — foreign sibling: pass another vault's SessionAccount → SessionAccountForeign", async () => {
    // Vault 1 (the one under test) + Vault 2 (donor of a foreign SessionAccount).
    const v1 = await bootstrapForRegister(program, provider, {
      usdcFundingAmount: 10_000_000n,
      migrateTo: 6,
    });
    const v2 = await bootstrapForRegister(program, provider, {
      usdcFundingAmount: 10_000_000n,
      migrateTo: 6,
    });

    // A live session in v1 (so v1's true live set is {A}); and a real
    // SessionAccount in v2 we'll smuggle in as a "sibling" of v1.
    const cpA = Keypair.generate().publicKey;
    const a = await registerA(v1, 3_000_000n, cpA);

    const foreignCp = Keypair.generate().publicKey;
    const foreign = await registerA(v2, 3_000_000n, foreignCp);

    // Register B in v1, passing the FOREIGN (v2) SessionAccount. It deserializes
    // fine (owner + discriminator OK) but sib.vault == v2 != v1 → reject.
    // Build remaining by hand: [A (v1), foreign (v2)] sorted ascending so the
    // ORDER check (i) passes and we reach the vault-bind check (iv).
    const cpB = Keypair.generate().publicKey;
    const sorted = sortSessionAccounts([a.sessionPda, foreign.sessionPda]);
    const remaining = sorted.map((pk) => liveMeta(pk));

    try {
      await registerRaw(program, provider, {
        vaultPda: v1.vaultPda,
        passkey: v1.passkey,
        vaultUsdcAta: v1.sourceAta,
        swigAddress: v1.swigAddress,
        swigWalletAddress: v1.swigWalletAddress,
        maxAmount: 1_000_000n,
        maxRevolvingCapacity: 1_000_000n,
        allowedCounterparty: cpB,
        remaining,
      });
      expect.fail("expected SessionAccountForeign");
    } catch (err: any) {
      expect(err.toString()).to.match(/SessionAccountForeign/);
    }
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 3. MISDERIVED — pass an account whose address != derive(vault, counterparty).
  //    A system-owned / non-SessionAccount address: Account::try_from fails the
  //    owner+discriminator check FIRST → SessionAccountForeign, NOT Misderived.
  //    To isolate Misderived we need a REAL SessionAccount of THIS vault whose
  //    on-chain address ≠ create_program_address(seed, stored bump). That can't
  //    be forged (the PDA IS the address), so the clean "misderived" trigger is
  //    a real-but-wrong PDA reached via the require_keys_eq at step (iv): we
  //    pass a SessionAccount whose STORED counterparty re-derives to a different
  //    key than its own address — impossible for a legitimately-created account.
  //
  //    The reachable, test-constructible Misderived path is the TARGET-IN-SET
  //    guard at (ii): an account that equals the target session PDA. We exercise
  //    the address-mismatch limb via a fresh non-PDA SessionAccount-shaped meta:
  //    the simplest concrete construction is a random Keypair pubkey, which is
  //    system-owned and trips Account::try_from → SessionAccountForeign. Because
  //    a genuine address-≠-derivation cannot be manufactured on-chain (the PDA
  //    constraint binds them), we assert the reachable owner/foreign limb here
  //    and document that the pure (iv) mismatch is unreachable by construction.
  // ───────────────────────────────────────────────────────────────────────────
  it("case 3 — misderived/non-PDA sibling: random address → SessionAccountForeign (PDA mismatch unreachable by construction)", async () => {
    const vault = await bootstrapForRegister(program, provider, {
      usdcFundingAmount: 10_000_000n,
      migrateTo: 6,
    });
    const cpA = Keypair.generate().publicKey;
    const a = await registerA(vault, 3_000_000n, cpA);

    // A bogus address that is NOT a SessionAccount PDA of this vault. It is
    // system-owned (or non-existent), so Account::try_from fails → Foreign. The
    // pure create_program_address mismatch (iv) cannot be reached from a real
    // chain account because the account's address IS its PDA — documented above.
    const bogus = Keypair.generate().publicKey;
    const cpB = Keypair.generate().publicKey;
    // Order [A, bogus] ascending so the order check (i) passes.
    const sorted = sortSessionAccounts([a.sessionPda, bogus]);
    const remaining = sorted.map((pk) => liveMeta(pk));

    try {
      await registerRaw(program, provider, {
        vaultPda: vault.vaultPda,
        passkey: vault.passkey,
        vaultUsdcAta: vault.sourceAta,
        swigAddress: vault.swigAddress,
        swigWalletAddress: vault.swigWalletAddress,
        maxAmount: 1_000_000n,
        maxRevolvingCapacity: 1_000_000n,
        allowedCounterparty: cpB,
        remaining,
      });
      expect.fail("expected SessionAccountForeign (or SessionAccountMisderived)");
    } catch (err: any) {
      // Accept either: a non-PDA system account fails owner/discriminator
      // (Foreign) before the PDA re-derive (Misderived) can fire. Both prove the
      // address-binding limb of the gate rejects an unbound sibling.
      expect(err.toString()).to.match(
        /SessionAccountForeign|SessionAccountMisderived/,
      );
    }
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 4. EXPIRED SIBLING SWEEP — A registered LIVE with a short expiry, then we
  //    wait for it to lapse, then register B passing the now-EXPIRED A (writable).
  //    The gate SWEEPS A (version → 0, registration zeroed), does NOT sum it, and
  //    B still registers. Count is re-synced (E.0 subtract swept, then +1 first
  //    touch → net unchanged at 1).
  //
  //    APPROACH (documented per the brief): register_session_key requires
  //    expires_at > now, so an EXPIRED sibling can only be obtained by
  //    registering it LIVE and letting wall-clock pass. We register A with a
  //    near-future expiry (now + SWEEP_TTL seconds) and BUSY-WAIT (poll the
  //    on-chain Clock via getBlockTime) until that timestamp passes, THEN run the
  //    B register. The wait is real on-chain time — NOT faked. On mainnet a few
  //    seconds is cheap; we use a small TTL and a generous poll budget. The test
  //    sets its own Mocha timeout to cover the wait.
  // ───────────────────────────────────────────────────────────────────────────
  it("case 4 — expired sibling is SWEPT (cleared, not summed); B still registers", async function () {
    // Real wall-clock wait → bump the per-test timeout well past the TTL.
    this.timeout(180_000);

    const SWEEP_TTL = 12; // seconds — short, but > finalized confirm jitter.
    const vault = await bootstrapForRegister(program, provider, {
      usdcFundingAmount: 10_000_000n,
      migrateTo: 6,
    });

    const cpA = Keypair.generate().publicKey;
    const cpB = Keypair.generate().publicKey;

    // A: live, expires at now + SWEEP_TTL. cap $3.
    const nowSec = Math.floor(Date.now() / 1000);
    const expiresAt = BigInt(nowSec + SWEEP_TTL);
    const a = await registerA(vault, 3_000_000n, cpA, { expiresAt });

    // Confirm A is live (count == 1) before we wait it out.
    let v: any = await program.account.vault.fetch(vault.vaultPda);
    expect(v.liveSessionCount).to.equal(1);

    // ── Busy-wait until the ON-CHAIN clock passes A's expiry. The gate compares
    //    sib.session.expires_at > Clock::get().unix_timestamp, so we must wait on
    //    the cluster clock (getBlockTime of the latest slot), not the local one.
    const deadline = Number(expiresAt);
    /* eslint-disable no-await-in-loop */
    for (let i = 0; i < 60; i++) {
      const slot = await provider.connection.getSlot("finalized");
      const blockTime = await provider.connection.getBlockTime(slot);
      if (blockTime !== null && blockTime > deadline + 2) break;
      await new Promise((r) => setTimeout(r, 3_000));
    }
    /* eslint-enable no-await-in-loop */

    // B: pass the now-EXPIRED A, marked WRITABLE (the sweep clears it). cap $4.
    const b = await registerSessionV2(program, provider, {
      vaultPda: vault.vaultPda,
      passkey: vault.passkey,
      vaultUsdcAta: vault.sourceAta,
      swigAddress: vault.swigAddress,
      swigWalletAddress: vault.swigWalletAddress,
      maxAmount: 4_000_000n,
      maxRevolvingCapacity: 4_000_000n,
      allowedCounterparty: cpB,
      siblings: [{ pubkey: a.sessionPda, isExpired: true }],
    });

    // A's PDA is SWEPT: version == 0, registration zeroed.
    const aAfter: any = await program.account.sessionAccount.fetch(a.sessionPda);
    expect(aAfter.version).to.equal(0);
    expect(aAfter.session.maxAmount.toString()).to.equal("0");

    // B exists with its cap.
    const bAcct: any = await program.account.sessionAccount.fetch(b.sessionPda);
    expect(bAcct.session.maxAmount.toString()).to.equal("4000000");

    // Count re-synced: started 1, swept A (−1), first-touch B (+1) → 1.
    v = await program.account.vault.fetch(vault.vaultPda);
    expect(v.liveSessionCount).to.equal(1);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 5. DUPLICATE SIBLING — pass [A, A] → the strict-ascending check (i) (`>` not
  //    `>=`) rejects equal adjacent keys → SessionAccountsNotSorted.
  // ───────────────────────────────────────────────────────────────────────────
  it("case 5 — duplicate sibling [A, A] → SessionAccountsNotSorted", async () => {
    const vault = await bootstrapForRegister(program, provider, {
      usdcFundingAmount: 10_000_000n,
      migrateTo: 6,
    });
    const cpA = Keypair.generate().publicKey;
    const cpB = Keypair.generate().publicKey;
    const a = await registerA(vault, 3_000_000n, cpA);

    // Deliberate dup — do NOT sort/dedup. Two identical metas.
    const remaining = [liveMeta(a.sessionPda), liveMeta(a.sessionPda)];

    try {
      await registerRaw(program, provider, {
        vaultPda: vault.vaultPda,
        passkey: vault.passkey,
        vaultUsdcAta: vault.sourceAta,
        swigAddress: vault.swigAddress,
        swigWalletAddress: vault.swigWalletAddress,
        maxAmount: 1_000_000n,
        maxRevolvingCapacity: 1_000_000n,
        allowedCounterparty: cpB,
        remaining,
      });
      expect.fail("expected SessionAccountsNotSorted");
    } catch (err: any) {
      expect(err.toString()).to.match(/SessionAccountsNotSorted/);
    }
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 6. OUT-OF-ORDER — pass [B, A] where B > A by pubkey → strict-ascending (i)
  //    fails on the second element → SessionAccountsNotSorted.
  // ───────────────────────────────────────────────────────────────────────────
  it("case 6 — out-of-order siblings [hi, lo] → SessionAccountsNotSorted", async () => {
    const vault = await bootstrapForRegister(program, provider, {
      usdcFundingAmount: 10_000_000n,
      migrateTo: 6,
    });
    // Register TWO live sessions so we have two real sibling PDAs to mis-order.
    const cpA = Keypair.generate().publicKey;
    const cpB = Keypair.generate().publicKey;
    const cpC = Keypair.generate().publicKey;
    const a = await registerA(vault, 2_000_000n, cpA);
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

    // DESCENDING order [hi, lo] — the reverse of the gate's requirement.
    const [lo, hi] = sortSessionAccounts([a.sessionPda, b.sessionPda]);
    const remaining = [liveMeta(hi), liveMeta(lo)];

    try {
      await registerRaw(program, provider, {
        vaultPda: vault.vaultPda,
        passkey: vault.passkey,
        vaultUsdcAta: vault.sourceAta,
        swigAddress: vault.swigAddress,
        swigWalletAddress: vault.swigWalletAddress,
        maxAmount: 1_000_000n,
        maxRevolvingCapacity: 1_000_000n,
        allowedCounterparty: cpC,
        remaining,
      });
      expect.fail("expected SessionAccountsNotSorted");
    } catch (err: any) {
      expect(err.toString()).to.match(/SessionAccountsNotSorted/);
    }
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 7. TARGET-IN-SET — include the target's OWN session PDA in siblings →
  //    require_keys_neq (ii) → SessionAccountMisderived.
  //
  //    The target B is a NEW counterparty (is_new == true), so its session PDA
  //    has version 0 and does not yet exist as a written account. We pass B's own
  //    PDA in the sibling set. The gate's (ii) check fires BEFORE the
  //    deserialize, so it doesn't matter that B's account is uninitialized.
  // ───────────────────────────────────────────────────────────────────────────
  it("case 7 — target's own PDA in the sibling set → SessionAccountMisderived", async () => {
    const vault = await bootstrapForRegister(program, provider, {
      usdcFundingAmount: 10_000_000n,
      migrateTo: 6,
    });
    const cpA = Keypair.generate().publicKey;
    const cpB = Keypair.generate().publicKey;
    const a = await registerA(vault, 3_000_000n, cpA);

    // The target B's own PDA.
    const [targetPda] = deriveSessionPda(program.programId, vault.vaultPda, cpB);

    // Sibling set includes the target itself (+ A so the set is otherwise
    // plausible). Sort ascending so the ORDER check (i) passes and we reach (ii).
    const sorted = sortSessionAccounts([a.sessionPda, targetPda]);
    const remaining = sorted.map((pk) => liveMeta(pk));

    try {
      await registerRaw(program, provider, {
        vaultPda: vault.vaultPda,
        passkey: vault.passkey,
        vaultUsdcAta: vault.sourceAta,
        swigAddress: vault.swigAddress,
        swigWalletAddress: vault.swigWalletAddress,
        maxAmount: 1_000_000n,
        maxRevolvingCapacity: 1_000_000n,
        allowedCounterparty: cpB,
        remaining,
      });
      expect.fail("expected SessionAccountMisderived");
    } catch (err: any) {
      expect(err.toString()).to.match(/SessionAccountMisderived/);
    }
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 8. COUNT-MISMATCH — pass ONE TOO MANY plausible siblings vs the true live
  //    set. Two live sessions exist (A, B); we register C passing [A, B, X] where
  //    X is a THIRD real-but-stale SessionAccount that is NOT in this vault's live
  //    accounting expectation... Actually the cleanest count-mismatch that lands
  //    on IncompleteSessionSet (not Foreign/Misderived) is TOO FEW: two live
  //    sessions {A, B}, register C passing only [A]. completeness (vi):
  //    live_counted+swept = 1, expected_total = live_session_count(2) − 0 = 2 →
  //    1 != 2 → IncompleteSessionSet. (Too-MANY with an extra valid sibling is
  //    impossible without that sibling being foreign/misderived, which trips an
  //    earlier check; too-FEW is the in-bounds count failure.)
  // ───────────────────────────────────────────────────────────────────────────
  it("case 8 — count mismatch (one too few): two live, pass only one → IncompleteSessionSet", async () => {
    const vault = await bootstrapForRegister(program, provider, {
      usdcFundingAmount: 10_000_000n,
      migrateTo: 6,
    });
    const cpA = Keypair.generate().publicKey;
    const cpB = Keypair.generate().publicKey;
    const cpC = Keypair.generate().publicKey;

    const a = await registerA(vault, 2_000_000n, cpA);
    await registerSessionV2(program, provider, {
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

    // Two live now (count == 2). Register C passing ONLY [A] → one short.
    try {
      await registerSessionV2(program, provider, {
        vaultPda: vault.vaultPda,
        passkey: vault.passkey,
        vaultUsdcAta: vault.sourceAta,
        swigAddress: vault.swigAddress,
        swigWalletAddress: vault.swigWalletAddress,
        maxAmount: 1_000_000n,
        maxRevolvingCapacity: 1_000_000n,
        allowedCounterparty: cpC,
        siblings: [{ pubkey: a.sessionPda }],
      });
      expect.fail("expected IncompleteSessionSet");
    } catch (err: any) {
      expect(err.toString()).to.match(/IncompleteSessionSet/);
    }
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 23. COMPUTE — register a session passing several live siblings, under an
  //     explicit ComputeBudget limit, to prove the per-sibling cost is bounded.
  //     The gate is O(n) over siblings; each sibling costs an Account::try_from
  //     (owner+discriminator) + a create_program_address re-derive (cheaper than
  //     find_program_address — no bump search). Registering 10-15 real prior
  //     sessions on mainnet is slow (each = a passkey ceremony + an init rent),
  //     so we register a SMALLER chain (a handful) and assert it lands within a
  //     generous CU budget; per-sibling cost being linear, the budget scales
  //     predictably to the documented max. The CU limit is set on the register
  //     tx itself — registerSessionV2 prepends no ComputeBudget ix, so we set it
  //     here via the raw path is not needed: a too-low budget would manifest as a
  //     "exceeded CUs" revert; landing within budget IS the assertion.
  //
  //     NOTE for the test-run phase: if you want a HARD CU ceiling assertion,
  //     wrap the register tx with ComputeBudgetProgram.setComputeUnitLimit and a
  //     low value, and assert it still succeeds (or capture the simulated
  //     unitsConsumed). The helper send path doesn't currently expose a CU knob;
  //     the linear-cost claim is what this case documents + smoke-tests.
  // ───────────────────────────────────────────────────────────────────────────
  it("case 23 — compute: register with several live siblings lands within budget (linear per-sibling cost)", async () => {
    const FUND = 100_000_000n; // $100 — generously covers a chain of small caps.
    const vault = await bootstrapForRegister(program, provider, {
      usdcFundingAmount: FUND,
      migrateTo: 6,
    });

    // Build a chain of N live sessions, each register passing all prior PDAs.
    // Keep N modest (mainnet cost); per-sibling cost is linear so this
    // smoke-proves the budget. Bump N in the test-run phase if you want to push
    // toward the documented max-sibling ceiling.
    const N = 6;
    const CAP = 1_000_000n; // $1 each — N caps + new cap ≤ $100 funding.
    const livePdas: PublicKey[] = [];

    for (let i = 0; i < N; i++) {
      const cp = Keypair.generate().publicKey;
      const r = await registerSessionV2(program, provider, {
        vaultPda: vault.vaultPda,
        passkey: vault.passkey,
        vaultUsdcAta: vault.sourceAta,
        swigAddress: vault.swigAddress,
        swigWalletAddress: vault.swigWalletAddress,
        maxAmount: CAP,
        maxRevolvingCapacity: CAP,
        allowedCounterparty: cp,
        // Pass every PRIOR live sibling (sorted by the helper).
        siblings: livePdas.map((pubkey) => ({ pubkey })),
      });
      livePdas.push(r.sessionPda);
    }

    // The final register (the Nth) passed N-1 siblings and landed → the gate's
    // O(n) walk stayed within the default CU budget for a meaningful sibling
    // count. Assert the live count reflects all N.
    const v: any = await program.account.vault.fetch(vault.vaultPda);
    expect(v.liveSessionCount).to.equal(N);
    expect(livePdas.length).to.equal(N);
  });
});
