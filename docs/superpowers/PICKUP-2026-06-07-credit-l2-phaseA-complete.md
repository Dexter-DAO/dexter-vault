# PICKUP — Credit-L2 Phase A COMPLETE, ready for the gated deploy. 2026-06-07

Read this first after a compact. Single source of truth for resuming with zero fidelity loss.
Written by credex/vault Claude (session continued from `e0a2c1c7`) for Branch.

═══════════════════════════════════════════════════════════════════════════════════
## TL;DR — WHERE WE ARE
═══════════════════════════════════════════════════════════════════════════════════

**Credit-L2 (external-financier standby credit — THE THESIS: a buyer spends PAST their own
balance on a financier's standby capital, non-custodially, and cannot rug the financier) has its
ENTIRE on-chain program (Phase A) BUILT, REVIEWED, and COMPILING CLEAN — 24 instructions.**

It is NOT deployed. The next step is **Phase B: the gated mainnet deploy (Branch's explicit
per-step go)**. Then Phase C: SDK builders + mainnet anti-rug/lifecycle tests.

The plan: `dexter-vault/docs/superpowers/plans/2026-06-07-credit-l2-standby-financier.md` (10 tasks,
3 phases, all design decisions + Ζ-gates documented). The design-lock:
`dexter-thesis/specs/2026-06-06-epsilon-credit-design-lock.md`.

═══════════════════════════════════════════════════════════════════════════════════
## THE BROADER ARC (where this sits — don't lose the map)
═══════════════════════════════════════════════════════════════════════════════════

Alpha→Zeta milestones. Α (custody+clearing+5x turnover) ✅. Β (drift fix V2/188) ✅.
Δ (LockedClaim) ✅ deployed+proven on mainnet. **Ε (credit) = WHERE WE ARE.** Then Ζ (open for business).

This session's completed work BEFORE Credit-L2 (all committed; SDK 0.4.2 published to npm):
- **Plan 0 — LockedClaim SDK builders** ✅ (dexter-vault-sdk: lockVoucher/settleLockedVoucher/
  transferLockOwnership/recoverAbandonedLock + deriveLockedClaimPda; 89 tests; published in 0.4.2).
- **Plan 1 — Factoring / instant-payout** ✅ (dexter-vault-sdk `@dexterai/vault/factoring`:
  computeFactoringSplit + buildInstantPayoutInstructions, fully wired SignV2; 98 tests). NOT credit
  (nobody goes negative) — financier buys a fully-backed claim, pays seller early at a discount.
- **Plan 2 — Credit L1 (Dexter-fronts)** — SKIPPED on purpose (proves no thesis; any co. lends its
  own money). We went straight to L2.
- **Plan 3 — Credit L2** — Phase A DONE (this doc), Phase B+C remain.

The fundraise framing (emailed): credit is an inference-DEMAND MULTIPLIER — it lets agents spend
past the user's wallet, manufacturing net-new inference demand. Doc:
`dexter-thesis/fundraise/2026-06-06-credit-as-inference-demand-multiplier.md`.

═══════════════════════════════════════════════════════════════════════════════════
## CREDIT-L2 — THE MECHANISM (locked design)
═══════════════════════════════════════════════════════════════════════════════════

- **Custody = Option A:** the financier's capital stays in THEIR OWN dexter-vault. A draw moves USDC
  directly from the financier's vault → seller at clearing time. NO pool account, NO escrow. Credit
  is as non-custodial as factoring. (This is the thesis edge over the MPC-escrow crowd.)
- **Authorization = standing pre-authorization:** the financier signs the backing policy ONCE
  (open_standby); the chain enforces bounds on every draw, no per-draw co-sign. Constitutive —
  per-draw co-sign would kill agent-speed credit.
- **Consent = TWO-SIG on open_standby (v1, security property):** the USER's vault passkey MUST sign
  to attach credit to their vault (closes a write-to-arbitrary-vault hole). v1: user passkey verified
  on-chain; financier identified by their swig account + wallet co-sign.
- **Pin = soft, slice-only:** finalize_withdrawal reserves `outstanding_locked + borrowed`. The user
  can't withdraw collateral backing an open loan; can repay-to-unlock.
- **Liquidation = deadline-seize, MIRROR of recover_abandoned_lock:** after borrow_recovery_at, the
  financier reclaims the borrowed slice from the user's pinned collateral.
- **Spread/fee = operator policy** (consumer-side, like the withdrawal fee + factoring spread). Not in
  the program.

### V5 Vault state (added this phase)
`borrowed: u64` (the buyer-is-negative accumulator), `standby_backer: Option<Pubkey>` (the financier's
vault), `standby_cap: u64` (the ceiling), `borrow_recovery_at: Option<i64>` (the seize deadline).
Invariants (verified airtight by the holistic review): `0 <= borrowed <= standby_cap`;
`borrowed == 0 ⟺ borrow_recovery_at == None`; cannot go negative / exceed cap / strand.

═══════════════════════════════════════════════════════════════════════════════════
## PHASE A — WHAT'S BUILT (24 instructions, all reviewed, compiles clean)
═══════════════════════════════════════════════════════════════════════════════════

Program: `Hg3wRaydFtJhYrdvYrKECacpJYDsC9Px7yKmpncj2fhc`. Currently DEPLOYED = 19 instructions
(Δ era). LOCAL build = 24 (the 5 new + the 19). NOT yet deployed.

Commits on `main` (dexter-vault), in order:
- `32b9834` — V5 state: 4 credit fields + 5 errors (CreditWouldExceedStandbyCap, WithdrawalWouldViolatePin,
  BorrowRecoveryTooEarly, NoStandbyBacker, NothingBorrowed). Also StandbyCapZero added later (7823a58).
- `4091ab1` — **open_standby** (two-sig consent: user passkey verified on-chain via SIMD-0075 sibling,
  op_msg = "open_standby"||vault||financier_swig||cap; financier by account). Consent gate verified UNBYPASSABLE.
- `7823a58` — **draw_credit** (the borrow; CAP GUARD `borrowed+amount<=standby_cap` checked_add;
  draws from the FINANCIER's swig == standby_backer; arms deadline first-draw-only) + StandbyCapZero.
- `f40b874` — **repay_credit** (pay down from the USER's swig; clamp `min(amount,borrowed)`; unpin at 0).
- `bce25b0` — **seize_collateral** (deadline liquidation, mirror of recover_abandoned_lock; deadline
  guard precedes mutation, unbypassable; seized = on-chain snapshot, empty args).
- `468bff9` — **finalize_withdrawal credit pin** (reserve `outstanding_locked + borrowed`; existing
  reservation check byte-for-byte unchanged; new pin = distinct WithdrawalWouldViolatePin check).
- `30b0886` + `0dd982f` — **migrate_v4_to_v5** (decode-V4/re-encode-V5; frozen VaultV4 decoder verified
  byte-for-byte == current Vault minus the 4 V5 fields; SessionRegistration unchanged so reused;
  ground-truth cited: 50 mainnet V4 vaults, 341 bytes, version==4).
- `90c2429` — **THE BLOCKER FIX** (found by the phase-level holistic review): request_withdrawal +
  finalize_withdrawal only gated V2/V3/V4, so a migrated V5 vault could NEVER withdraw AND the credit
  pin was unreachable dead code. Added `|| V5` to both gates. Pin now reachable for V5. Verified ✅.

Every task: fresh-subagent implement → spec-compliance review → code-quality review (the rigor caught
real traps: the two-sig consent hole, the financier-swig direction, the frozen-decoder fidelity, and
the V5-withdrawal blocker). Whose-swig is correct everywhere: draw=financier, repay+seize=user.

═══════════════════════════════════════════════════════════════════════════════════
## NEXT — PHASE B: GATED MAINNET DEPLOY (Branch's explicit go required)
═══════════════════════════════════════════════════════════════════════════════════

Task 8 in the plan. DO NOT deploy without Branch's per-step approval.
1. `anchor build` (emits fresh target/idl with all 24 ix + V5).
2. Confirm upgrade-authority wallet `X4o2kSLzqEQjnAzhq3L3BW92aawMV2n2F37EXd2GMpy` has ≥ 3.1 SOL
   (the transient deploy buffer; `~/.config/solana/dexter-vault/upgrade-authority.json`).
3. `solana program extend Hg3wRayd... <bytes>` (size delta), THEN `solana program deploy ...`.
   ALWAYS Helius RPC: `https://mainnet.helius-rpc.com/?api-key=8fd1a2cd-76e7-4462-b38b-1026960edd40`.
4. Record upgrade sig + new .so hash + confirm 24 instructions on-chain.
DEPLOY GOTCHA: `solana program deploy` writes a full ~3 SOL transient buffer even after extend;
wallet needs ~3.1+ at deploy time; buffer reclaims after. (Documented from the Δ deploy.)

═══════════════════════════════════════════════════════════════════════════════════
## THEN — PHASE C: SDK builders + mainnet tests (Tasks 9-10)
═══════════════════════════════════════════════════════════════════════════════════

Task 9 (SDK, dexter-vault-sdk): add 5 discriminators (sha256("global:<ix>")[..8], cross-check vs the
FRESH dexter-vault/target/idl — the bundled SDK idl is stale; that was a Plan-0 lesson) for
open_standby/draw_credit/repay_credit/seize_collateral/migrate_v4_to_v5; create `src/instructions/credit.ts`
builders mirroring lockedClaim.ts; byte-parity tests; export. Source-only, NO publish (gated).

Task 10 (mainnet tests) — THE MUST-TEST LIST (from the holistic review — do not skip any):
1. **V5 withdrawal regression** (proves the blocker fix): migrate→V5, withdraw with borrowed==0 OK;
   borrowed>0 fails WithdrawalWouldViolatePin; withdraw exactly `balance-(outstanding_locked+borrowed)`
   OK, one lamport more fails.
2. **Cap guard**: draw to exactly standby_cap OK; one over fails CreditWouldExceedStandbyCap.
3. **Deadline arming**: first draw arms; second draw does NOT push deadline (top-up-to-defer attack);
   repay-to-0 clears; partial repay keeps armed.
4. **Seize timing**: seize at deadline-1 fails BorrowRecoveryTooEarly; at deadline OK, zeroes borrowed,
   clears deadline, sibling SignV2 transfers exactly the pre-zero snapshot. (Use short window or the
   recover-abandoned-lock skip pattern for the wall-clock wait.)
5. **Whose-swig** (money-from-wrong-vault risk): draw debits the FINANCIER's ATA; repay+seize debit
   the USER's ATA — verify on-chain balances, not just success.
6. **ProgramExec marker placement** (CRITICAL test-setup): draw_credit marker on the FINANCIER's swig;
   repay/seize markers on the USER's swig. A marker on the wrong swig must fail the SignV2. THIS is the
   second fund-safety leg — if mis-registered, it's only enforced in theory.
7. **open_standby consent binding**: user-passkey sig replayed vs a different vault / financier / cap
   must all reject (op_msg binds all three).
8. **open_standby WITHOUT user consent rejected** (the authorization gate — anti-abuse #4).
9. **Migration fidelity**: a real 341-byte V4 vault decodes→re-encodes V5 with neutral credit fields,
   stays rent-exempt, all carried-over fields survive byte-for-byte.
Mainnet only (secp256r1 mainnet-only). Helius RPC. Shared harness tests/helpers/settle.ts +
enrollLockableVault for exact funding. Sandbox disabled for node fetch.

═══════════════════════════════════════════════════════════════════════════════════
## Ζ-GATES (deferred, DOCUMENTED hard prerequisites — NOT silent gaps, NOT v1)
═══════════════════════════════════════════════════════════════════════════════════

All in the plan's design-decisions section. Before any REAL external financier onboards:
1. **Buyer-protection**: min recovery windows, buyer consent to cap/terms, max effective rate. v1 is
   fine because Branch controls both sides (no adversarial financier).
2. **Financier on-chain passkey** = ASYNC pre-sign-and-redeem (financier passkey-signs backing intent
   ahead of time, redeemed at user opt-in) — NOT synchronous two-passkeys-in-one-tx (the verifier
   introspect_simd_0075 handles one precompile sibling at one fixed position). Required for
   non-repudiation + hot-key-delegation safety. The async shape is the RIGHT design (captured so a
   future builder doesn't build the clumsy literal one).

═══════════════════════════════════════════════════════════════════════════════════
## KNOWN NON-BLOCKING NITS (logged, not fixed — fine for v1)
═══════════════════════════════════════════════════════════════════════════════════
- Dual-use errors: `NoStandbyBacker` (None + mismatch in draw_credit), `NothingBorrowed` (borrowed==0
  + unarmed-deadline in seize). A dedicated mismatch/unarmed error each would aid debugging. Cosmetic.
- `let _ = seized;` in seize_collateral reads as "discard" though the value is the point (consumed by
  the SignV2). Could be `_seized` or inlined. Cosmetic.
- Deadline-overflow + locked+borrowed-overflow map to domain errors (CreditWouldExceedStandbyCap /
  WithdrawalWouldViolatePin) rather than a dedicated ArithmeticOverflow. Consistent with the file's
  existing convention; unreachable under real balances. Cosmetic.
- Tail-period style on the 5 new error #[msg] strings differs from the rest of the enum. Cosmetic.
None affect fund safety. Capture as a future cleanup pass if desired.

═══════════════════════════════════════════════════════════════════════════════════
## ENVIRONMENT / DISCIPLINE (so it doesn't bite)
═══════════════════════════════════════════════════════════════════════════════════
- Build: `export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"` then
  `cargo build-sbf` (compile check) or `anchor build` (full, emits IDL). cargo-build-sbf 3.1.14, anchor 0.32.1.
- RPC: ALWAYS Helius, NEVER mainnet-beta. (in dexter-vault/.env as HELIUS_RPC_URL, gitignored.)
- Mainnet tests need sandbox disabled for node fetch; ~140-160s per vault provisioning; use `-g` to target.
- The SignV2 ProgramExec marker must be registered on the RIGHT swig (draw=financier, repay/seize=user)
  on enrollment — tests handle this; it's the second fund-safety leg.
- NO publish / NO version bump on the SDK without Branch's go. The program deploy (Phase B) is the one
  gated mainnet action. All Credit-L2 work is local/unpushed on main.

═══════════════════════════════════════════════════════════════════════════════════
## RESUME — exact next move
═══════════════════════════════════════════════════════════════════════════════════
Phase A is done + the blocker fixed + holistic review passed (after the fix). The natural next step is
**Phase B (gated deploy)** — bring Branch the deploy as an explicit go/no-go (anchor build, check SOL,
extend+deploy). Then Phase C (SDK builders Task 9, then the must-test list Task 10). Do NOT deploy or
publish without Branch's per-step approval.
