# PICKUP — Phase 1 LockedClaim COMPLETE, road back to A-to-Z. 2026-06-06 (late)

Read this first after a compact. It is the single source of truth for resuming with zero
fidelity loss. Written by credex/vault Claude (session `e0a2c1c7`, continued) for Branch.

═══════════════════════════════════════════════════════════════════════════════════
## TL;DR — WHERE WE ARE
═══════════════════════════════════════════════════════════════════════════════════

**Phase 1 (LockedClaim / the credit-claim "crystallized tier") is BUILT, DEPLOYED to
Solana mainnet, and ITS ENTIRE TEST SUITE IS GREEN ON MAINNET (16 tests).** The single most
important claim — *the buyer cannot rug the seller, non-custodially* — is PROVEN on-chain,
three independent ways, each with a real failed transaction.

What's LEFT before "Phase 1 fully shipped": publish the SDK (0.4.2), migrate the V3 vaults,
push commits. All gated to Branch. Then the road continues to the A-to-Z demo (Phases 2-4).

═══════════════════════════════════════════════════════════════════════════════════
## THE TWO INVENTIONS (the why — never lose this framing)
═══════════════════════════════════════════════════════════════════════════════════

1. **Non-custodial managed wallet** — software transacts for a user, by their signed
   authorization, never holding their keys. (dexter-vault program + Swig session-key/passkey.)
2. **The credit-claim primitive ("credex" / LockedClaim)** — a voucher crystallizes into a
   transferable, buyer-IRREVOCABLE, on-chain claim a financier can buy and collect on, backed
   by the user's own funds, where the buyer cannot rug the seller. THIS is what Phase 1 built.

The credit model is **velocity-based, NOT unsecured lending**: a small balance clears large
volume over time by revolving (lock→settle→lock), every claim fully backed at every instant.
That's what keeps it non-custodial. (Buyer can't authorize/lock more than the vault holds at
any instant; capacity revolves over time.) Canonical: `dexter-thesis/V0.3-IMPLEMENTATION-RISK-DECISIONS.md`.

═══════════════════════════════════════════════════════════════════════════════════
## ON-CHAIN STATE (Solana mainnet) — the receipts
═══════════════════════════════════════════════════════════════════════════════════

- **Program:** `Hg3wRaydFtJhYrdvYrKECacpJYDsC9Px7yKmpncj2fhc`
- **Deployed: 19 instructions** (was 14 this morning; +4 LockedClaim + migrate_v3_to_v4).
  Upgrade sig `36KX827gqyV4BarqEj9xTcm7CMPjSHhkmzHUB4hnYVVVpdzJXXXP6mTmXZMJ9xdjqURTDqKPtu15GnVzG6rHPDsp`.
  .so hash `2920d27cd1ed30ea77e661ca57ec20f4fbb37452f789a543afb39b32203d9cd5`, 432,120 bytes.
- **Program-data account** `B8JA9f4dgtHAAGdAxFkT4CP2cxVzBTWA1GEj8FJjFtmy` — extended to 439,325 bytes.
- **DEPLOY GOTCHA (remember for next upgrade):** `solana program deploy` ALWAYS writes a full
  ~3 SOL transient buffer, even if you pre-`extend`. So the upgrade authority wallet needs
  ~3.1+ SOL AT DEPLOY TIME (the buffer reclaims after). Two-step that worked:
  `solana program extend <PROGRAM_ID> <bytes>` (pays only the size delta) THEN
  `solana program deploy ...`. Use Helius RPC (see below).
- **Upgrade authority wallet:** `X4o2kSLzqEQjnAzhq3L3BW92aawMV2n2F37EXd2GMpy`
  (`~/.config/solana/dexter-vault/upgrade-authority.json`). Had ~3.48 SOL after deploy.

═══════════════════════════════════════════════════════════════════════════════════
## PHASE 1 TEST SUITE — ALL GREEN ON MAINNET (the proof)
═══════════════════════════════════════════════════════════════════════════════════

16 passing, 3 intentional skips (90-day wall-clock waits, documented in-file). Run any file:
```
ANCHOR_WALLET=$HOME/.config/solana/dexter-vault/upgrade-authority.json \
ANCHOR_PROVIDER_URL="<HELIUS URL>" \
npx ts-mocha -p ./tsconfig.json -t 600000 tests/<file>.ts -g "<grep>"
```

THE SAFETY HALF — "buyer cannot rug seller" (the thesis, 3 attack vectors):
- ✅ Anti-rug #1 `lock_voucher` over-commit — drained vault rejects unbacked lock
  (`LockWouldOvercommitVault` 6016/0x1780). tests/lock-voucher.ts "over-cap".
- ✅ Anti-rug #2 `finalize_withdrawal` reservation — can't withdraw below locked
  (`WithdrawalWouldViolateReservation`). tests/finalize-withdrawal-reservation.ts.
- ✅ Anti-rug #3 `register_session_key` overcommit — can't authorize past balance
  (`SessionWouldOvercommitVault`). tests/register-session-overcommit.ts.
- ✅ XOR Test 1 & 2 — lock-then-settle AND settle-then-lock both rejected (frontier guard).
- ✅ lock_voucher graduation (revocable→crystallized tier).

THE LIFECYCLE HALF — "it works end to end" (the financier story):
- ✅ transfer_lock_ownership — financier buys claim; imposter transfer rejected. tests/transfer-lock-ownership.ts.
- ✅ settle_locked_voucher — financier collects USDC; imposter + double-settle rejected. tests/locked-claim-settle.ts.
- ✅ recover_abandoned_lock — buyer safety valve; early + indefinite rejected. tests/recover-abandoned-lock.ts.

═══════════════════════════════════════════════════════════════════════════════════
## WHAT'S LEFT TO FULLY SHIP PHASE 1 (all gated to Branch)
═══════════════════════════════════════════════════════════════════════════════════

Full checklist: `dexter-vault/docs/superpowers/COMBINED-PHASE-1-DEPLOY-CHECKLIST.md`.
The PROGRAM is deployed & proven; what remains:

1. **Publish `@dexterai/vault` 0.4.2** (STAGED, build-only, NOT published — registry still
   shows 0.4.1). It updates register_session_key (2→5 accounts) and finalize_withdrawal (4→5)
   builders to match the deployed program's new account lists. WITHOUT this, every client's
   register/finalize breaks against the upgraded program. Commits 998d7b5, 3502f5b, cb25bcb in
   dexter-vault-sdk. `cd dexter-vault-sdk && npm publish` (outward-facing — Branch's go).
2. **Migrate the V3 vaults to V4.** 8 V3 vaults exist (6 Some, 2 None), 7 under the upgrade
   wallet's authority. Test+migrate: `RUN_MIGRATION_PROOF=1 ... npx ts-mocha ... tests/migrate-v3-to-v4.ts`.
   IRREVERSIBLE per vault (reallocs to 341B). Defaults are throwaway vaults; override via
   MIGRATE_V3_SOME_VAULT / MIGRATE_V3_NONE_VAULT. (NOTE: existing V3 vaults still WORK for
   lock-only/settle paths via the V4||V3||V2 version gates — migration only needed before a
   typed reservation read on that specific vault. Not urgent.)
3. **Bump consumers** to ^0.4.2 (dexter-facilitator, dexter-x402-sdk) + reinstall, after publish.
4. **Push** all Phase 1 commits (dexter-vault, dexter-vault-sdk, dexter-facilitator are all
   LOCAL/UNPUSHED — Branch's call). NOTE: @dexterai/vault 0.4.0 + 0.4.1 ARE already public on npm.

═══════════════════════════════════════════════════════════════════════════════════
## THE MASTER PLAN — the road back to A-to-Z (where this all goes)
═══════════════════════════════════════════════════════════════════════════════════

Canonical roadmap: `dexter-thesis/A-TO-Z-HOLY-SHIT-DEMO.md`. **Its Phase 1 numbered steps are
STALE (predate the meter) — V0.3 + the signed seam spec are canonical for Phase 1.** But the
GLOBAL ARC (Phases 2-4) is canonical and is where we go next:

- **Phase 1 (steps 1-9): vault program — LockedClaim.** ✅ DONE + proven on mainnet (this is us).
- **Phase 2 (steps 10-14): SDK builders + Tab API surface.** PARTIALLY DONE — 0.4.2 has the
  register/finalize account-list updates staged. STILL NEEDS: SDK builders for the 4 new
  LockedClaim instructions (lockVoucher, transferLockOwnership, settleLockedVoucher,
  recoverAbandonedLock), the LockedClaim account decoder, byte-parity snapshots, and a
  `tab.lock()` method in @dexterai/x402. Bump @dexterai/vault to 0.5.0 / @dexterai/x402 to 3.12.0.
- **Phase 3 (steps 15-17): indexer + THE DEMO PAGE.** The "holy shit": a live mainnet demo at
  dexter.cash/demo/locked-claim walking the 17-stage lifecycle with THREE on-chain
  attack-failures (withdraw rejected, register rejected, the reservation breach) as real Solscan
  links. **THE 3 ANTI-RUG TESTS WE JUST PROVED ARE THE REHEARSAL FOR THESE DEMO STAGES** — the
  drain-then-lock / over-withdraw / over-register sequences are exactly the demo's attack stages.
  The shared settle harness (tests/helpers/settle.ts) is ~the machinery the demo backend needs.
  Plus: dexter-api indexer endpoints for the LockedClaim lifecycle (Postgres tables, event log).
- **Phase 4 (steps 18-21): mainnet smoke + IETF I-D revision (passkey-p256-session-v2 documenting
  LockedClaim) + ship.**

**"Z" = the live demo proving the financial primitive on mainnet with real USDC + Face ID, where
the buyer's three rug attempts each produce a real on-chain rejection.** We have now PROVEN all
three rejections work; Phase 3 wraps them in a demo UI.

═══════════════════════════════════════════════════════════════════════════════════
## THE TWO-AGENT STRUCTURE (co-lead, both halves done)
═══════════════════════════════════════════════════════════════════════════════════

- **credex/vault Claude (THIS session):** owns the meter, migration, the SDK byte layer, and
  the seam to the meter. Built: credex meter (shipped, 5x proven), Thread B (V2/188 stack
  coherence), migrate_v3_to_v4, the 0.4.2 SDK account-list update, and reviewed all 4
  seam-touching commits of Phase 1.
- **Phase 1 / synthesis Claude (dexter-facilitator session):** owns LockedClaim instruction
  design. Built: the 4 instructions, 2 modified handlers, LockedClaim account, 5 errors, the
  tests. His pickup: `dexter-facilitator/.../SESSION_PICKUP.md`. His plan:
  `dexter-facilitator/docs/superpowers/plans/2026-06-05-locked-claim-phase-1.md`.
- **The signed contract between them:** `dexter-thesis/SEAM-SPEC-credex-meter-meets-lockedclaim.md`
  (the frontier guard `cumulative > max(spent, crystallized)`, the graduation, the XOR invariant).
- Branch routes between them. They communicate agent-to-agent via Branch relaying copy-paste blocks.

═══════════════════════════════════════════════════════════════════════════════════
## OPEN ITEMS / FLAGS (don't lose these)
═══════════════════════════════════════════════════════════════════════════════════

1. **lock-without-open metrics flag (LOW severity, NOT a safety hole).** `lock_voucher` doesn't
   require a prior open (`current_outstanding -= delta` uses `saturating_sub`, clamps to 0) and
   doesn't touch `pending_voucher_count`. So a seller can crystallize a claim that skipped the
   revocable meter tier. SAFETY IS FULLY INTACT (cap/over-commit/frontier/signature all fire
   regardless). The ONLY residual: the credex velocity/turnover METRIC could under-report or be
   gamed. DESIGN DECISION for the other agent: should lock require `current_outstanding >= delta`
   (`checked_sub`) instead of `saturating_sub`? Full writeup appended to
   `dexter-vault/docs/FINDINGS-lock-overcommit-test.md`. Capture as a choice, not a bug.
2. **3 skipped tests** are intentional (90-day holder_recovery_at waits; manual mainnet
   verification protocol documented in-file). Not gaps.
3. **The two "failures" during the test march were BOTH fixture bugs masking correctly-working
   guards** — the program was right every time. (over-cap funded too much → guard unreachable;
   withdrawal-reject left pending_voucher_count>0 → wrong guard fired first. Both fixed; the
   guards proven specifically.)

### DEFERRED NITS (small "we'll do it later" items, verified still-undone 2026-06-06)
- **[CONFIRMED UNDONE] Tighten the turnover-demo assertion.** `tests/revolving-meter.ts:349` is
  still `expect(turnover).to.be.greaterThan(1)`. Seam-spec Q-OPEN-3 agreed to tighten it to
  `>= ROUNDS*CLAIM/REVOLVING` so it proves 5x SPECIFICALLY, not just ">1x". One-liner. Trivial.
- **[RESOLVED — LEAVE IT] V1 register-domain constant.** CHECKED 2026-06-06:
  `OTS_SESSION_REGISTER_V1_DOMAIN` (constants/index.ts:60) is used by NO production code — only by a
  byte-parity test that snapshots it (byte-parity.test.ts:91). So it's not "dead tech debt," it's a
  documented historical byte-parity artifact (proof of the V1 layout pre-migration). Deleting it
  would mean deleting its test too, for ~zero benefit. VERDICT: leave it. (Note: `OTS_SESSION_REVOKE_V1_DOMAIN`
  is a SEPARATE constant that IS still live — session.ts:85 builds the revoke message with it. Don't
  confuse the two.) This nit is CLOSED, not deferred.
- **[NICE-TO-HAVE] `registerSettleableVault` 4x auto-funding footgun.** tests/helpers/settle.ts
  auto-funds `4 * max(maxAmount, maxRevolvingCapacity)`. This caused a FALSE-PASS trap in the
  over-cap test (over-funded → guard unreachable → test would've passed for nothing). It's fine as
  long as everyone knows; consider making funding an explicit required param so the footgun can't
  recur. (enrollLockableVault already takes exact usdcFundingAmount — use it when you need control.)
- **[NICE-TO-HAVE / Phase 3] Resume cap-from-chain breadcrumb.** Thread B left a comment in
  dexter-x402-sdk resumeTab() that a resumed session should READ max_revolving_capacity from chain
  (don't re-supply), and never persist a session key. Captured in code; surfaces in Phase 3 resume work.
- **[IN CHECKLIST] Consumer bumps to ^0.4.2** (dexter-facilitator, dexter-x402-sdk) — must happen
  AFTER the 0.4.2 publish. Already in COMBINED-PHASE-1-DEPLOY-CHECKLIST.md step 7; restated here so it's not lost.
- **[ABANDONED ON PURPOSE] ~0.65 SOL spent on the program-data `extend` during deploy is gone-but-fine**
  (it permanently funds the now-larger program-data account — it's not lost, it's rent). The transient
  deploy buffer reclaimed fully. Branch said forget chasing any SOL back. Net deploy cost was tiny.

═══════════════════════════════════════════════════════════════════════════════════
## ENVIRONMENT / DISCIPLINE (the operational facts that bit us, so they don't again)
═══════════════════════════════════════════════════════════════════════════════════

- **RPC: ALWAYS Helius, NEVER api.mainnet-beta.solana.com** (mainnet-beta caused every flake).
  URL: `https://mainnet.helius-rpc.com/?api-key=8fd1a2cd-76e7-4462-b38b-1026960edd40`
  (also in `dexter-vault/.env` as HELIUS_RPC_URL — `.env` is gitignored, key never commits).
- **PATH for builds:** `export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"`
  (toolchain installed but not on default subagent PATH — `cargo-build-sbf 3.1.14`, anchor 0.32.1).
- **Mainnet test runs need sandbox disabled** for node fetch (curl works under sandbox; fetch doesn't).
- **TEST RUNNER GOTCHA:** ts-mocha runs ALL describe blocks a file imports — so a file that imports
  the lock describe blocks re-runs them (~2.5 min each on mainnet). ALWAYS use `-g "<grep>"` to
  target just the new tests, or you wait ~13 min re-proving green tests.
- **ATA race:** never use SPL `getOrCreateAssociatedTokenAccount` directly in mainnet tests (it
  swallows errors + single non-retry read → replica race). Use `createAtaIdempotentFinalized`
  (poll-until-finalized) in tests/helpers/secp256r1.ts.
- **Shared settle harness:** `tests/helpers/settle.ts` exports registerSettleableVault + settle +
  MeterVaultContext (extracted from revolving-meter.ts, behavior-preserving, 5x proof re-verified).
  Note: `registerSettleableVault` AUTO-FUNDS 4x max(maxAmount,maxRevolvingCapacity) — for exact
  funding control use `enrollLockableVault` (tests/lock-voucher.ts) which takes usdcFundingAmount directly.
- **Mainnet tests are MANDATORY** for anything touching secp256r1 (passkey) — the precompile is
  mainnet-only, no local validator. Each full vault provisioning is ~140-160s.

═══════════════════════════════════════════════════════════════════════════════════
## KEY DOCS INDEX (read order for a fresh session)
═══════════════════════════════════════════════════════════════════════════════════

1. THIS doc (you are here).
2. `dexter-vault/docs/superpowers/COMBINED-PHASE-1-DEPLOY-CHECKLIST.md` — the remaining ship steps.
3. `dexter-thesis/A-TO-Z-HOLY-SHIT-DEMO.md` — the master roadmap (Phases 2-4 are the road ahead).
4. `dexter-thesis/V0.3-IMPLEMENTATION-RISK-DECISIONS.md` — the LockedClaim engineering spec (canonical).
5. `dexter-thesis/SEAM-SPEC-credex-meter-meets-lockedclaim.md` — the signed meter↔lock contract.
6. `dexter-vault/docs/FINDINGS-lock-overcommit-test.md` — the over-commit analysis + lock-without-open flag.
7. `dexter-vault/docs/superpowers/PICKUP-2026-06-05-credex-metering.md` — prior pickup (meter + Thread B history).

## COMMITS THIS SESSION (all local/unpushed unless noted)
- dexter-vault: Phase 1 LockedClaim (d15e27a..c4d9fe5 by other agent) + migrate_v3_to_v4
  (a6ae417..ab9a18f) + test fixes (66ced86, 01badd6, 3b9017f) + the settle-harness extract (044548a).
- dexter-vault-sdk: 0.4.2 account-list update (998d7b5, 3502f5b, cb25bcb). 0.4.0/0.4.1 PUBLISHED to npm.
- dexter-facilitator: dep bumps + length floor (committed, unpushed).

═══════════════════════════════════════════════════════════════════════════════════
## NEXT SESSION — WHERE TO PICK UP
═══════════════════════════════════════════════════════════════════════════════════

Branch decides the order, but the natural next moves:
- **(a) Finish shipping Phase 1:** publish 0.4.2, migrate the controllable V3 vaults, push. (Mechanical, gated.)
- **(b) Phase 2:** SDK builders for the 4 LockedClaim instructions + tab.lock() (the other agent's
  territory, but the SDK byte layer is credex/vault's — coordinate).
- **(c) Phase 3:** the demo page — and the 3 anti-rug tests we just proved are the rehearsal/backend
  for its attack-failure stages; the shared settle harness is the machinery.

The hard, irreversible, safety-critical work is DONE. The thesis is proven on mainnet. What remains
is build-out (SDK, demo, indexer, I-D), not proof. Execution risk, not existence risk.
