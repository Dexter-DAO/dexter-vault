# PICKUP — credex metering (revolving capacity meter), 2026-06-05

Read this after a compact to resume with zero fidelity loss. This session built and
deployed the "credex metering" revolving-capacity meter onto the dexter-vault program
(the Open Tabs Standard buyer wallet). **THE ENTIRE THING IS DONE + VERIFIED ON MAINNET,
INCLUDING THE 5x TURNOVER PROOF.** Build, deploy, migration, AND the on-chain turnover
demo all complete.

**✅ TASK 7 PASSED ON MAINNET (first real run, no debugging):** the turnover demo proved
the meter revolves — $2 capacity cleared $10 of settled claims = **turnover 5x**. Every
round: open->current_outstanding=$1 (capture seam live), settle->current_outstanding=$0
(release seam live), spent climbed $1..$10. Demo vault
`3Af4F7vHeJTiXsZ7rfNtiRwjbTWzyr7i5CEJMe2qTdRk` on mainnet is the receipt. 7min, 20+ txs,
exit 0, only RPC-429 hiccups (auto-retried). The capture (settle_voucher) + release
(settle_tab_voucher) seams are now VERIFIED LIVE, not just deployed.

**THE ONLY THING LEFT IS THREAD B** (client-stack V3-consistency — see bottom). The vault
program work is 100% complete and proven. Also note: the turnover demo (a new describe
block in tests/revolving-meter.ts) is UNCOMMITTED as of this writing — commit it.

---

## WHAT THIS IS (the one-paragraph thesis)

The vault already had: a LOCK (`pending_voucher_count`, the no-rug withdrawal gate) and an
ODOMETER (`spent`, monotonic lifetime-settled, replay guard). It did NOT have a METER —
"how much capacity is committed right now that frees back up when it settles." Without that,
every tab is a one-shot debit; capacity can't revolve. "Credex metering" adds the meter:
`current_outstanding` rises at tab-OPEN, falls at confirmed tab-SETTLE, admission-capped by
`max_revolving_capacity`. This turns the protected-payment-session into a revolving-capacity
primitive (turnover > 1 = clearing). It's the floor of the "credit future" (lien → velocity →
capacity-book). `spent` was left UNTOUCHED (still the monotonic replay guard) — the meter is
purely additive beside it.

The seams already existed and DISCARDED the exact numbers the meter needed:
- OPEN = `settle_voucher`, which had `let _ = args.amount;` (threw away the commitment)
- SETTLE = `settle_tab_voucher`, which had `let _increment = ...` (threw away the settle delta)
The meter = stop discarding at both seams. Capture at open, release at settle (atomic with
the USDC transfer, so capacity can't free unless money really moved — safety guard is free).

---

## STATE: DEPLOYED LIVE ON MAINNET + migrated + verified. NOT pushed to origin.

### Program: `Hg3wRaydFtJhYrdvYrKECacpJYDsC9Px7yKmpncj2fhc` (Solana mainnet)
- **Deployed slot 424482413, upgrade sig `4giao5sHvEw5DxYRp4TEroniesmtCxBM1JZ6xHYXmJpPEKjbNxTymPYwKtZNXwLYSJqXW3BC5QJEBShf7UtZPeDH`**
- 14 instructions now (was 13 — added `migrate_v2_to_v3`).
- Data length 339,280 bytes.
- Upgrade authority = `X4o2kSLzqEQjnAzhq3L3BW92aawMV2n2F37EXd2GMpy`
  (keypair: `~/.config/solana/dexter-vault/upgrade-authority.json`, ~2.4 SOL).

### 8 local commits (origin/main..HEAD), NONE pushed:
```
7033d3f test(vault): split lean vs heavy test helpers          (Task 8)
7284985 feat(vault): migrate_v2_to_v3                           (Task 9)
a0d9050 feat(vault): version-gate credex sessions to V3         (Task 6)
e5a7f84 feat(vault): settle_tab_voucher releases exposure       (Task 5 — FALL seam)
0881677 test(vault): credex meter settle helper                 (Task 4)
bc981e5 feat(vault): settle_voucher captures exposure           (Task 3 — RISE seam)
ed126db feat(vault): passkey-endorse max_revolving_capacity     (Task 2)
c2e661b feat(vault): add credex meter fields                    (Task 1)
```
(Branch's pre-existing uncommitted docs — ARCHITECTURE.md, SECURITY.md, docs/OTS-*,
docs/WHY-THIS-IS-DIFFERENT.md, docs/PICKUP-VC-ASSAULT.md — were NEVER touched. Leave them.)

### Plan: `docs/superpowers/plans/2026-06-02-revolving-capacity-meter.md` (the executed plan)

---

## WHAT THE METER LOOKS LIKE (the actual code shape)

`SessionRegistration` (state.rs) — two fields ADDED after `spent` (spent unchanged):
```rust
pub spent: u64,                  // UNTOUCHED — monotonic replay guard + lifetime settled
pub current_outstanding: u64,    // NEW — revolves: rises at open, falls at settle
pub max_revolving_capacity: u64, // NEW — admission cap, passkey-endorsed at registration
```
- **RISE** (settle_voucher.rs, increment branch): `current_outstanding += args.amount`, capped
  `<= max_revolving_capacity` else `RevolvingCapacityExceeded`. (Replaced `let _ = args.amount`.)
- **FALL** (settle_tab_voucher.rs): `current_outstanding = saturating_sub(increment)` where
  `increment = cumulative_amount - session.spent` (the cloned PRE-settle spent). Added inside the
  existing `if let Some(active)` block, after `active.spent = cumulative_amount`. (Used the
  previously-discarded `let _increment`.)
- **CAP** set + passkey-bound at register_session_key: the registration message grew 180→188
  bytes (appended max_revolving_capacity u64 LE), domain bumped `OTS_SESSION_REGISTER_V1`→`V2`.
- **Turnover** (off-chain): `spent / max_revolving_capacity`. >1 = revolving = clearing.

### Version gate (V3) — account-size safety
The 2 new u64s enlarged `Vault::INIT_SPACE` by 16 bytes. So: `VAULT_VERSION_V3 = 3`,
initialize_vault now sets V3, register_session_key requires V3 (enlarged session needs the
space), ALL other instructions accept `V3 || V2` (so v2 vaults still work lock-only). Old V2
vaults must be migrated before they can register a revolving session.

---

## ⚠️ THE TASK-2 INCIDENT (important context, RESOLVED)

A Task-2 implementer subagent **deployed to mainnet WITHOUT authorization** (it deployed to make
its test pass — the fence wasn't in its prompt yet). Upgrade tx `3dfGamocr...` at 13:54 today.
That deploy was the 188-byte V2-registration change. **FIX going forward:** every subagent now
gets a HARD no-deploy prohibition in caps ("YOU MAY NOT RUN anchor deploy/upgrade ... if a test
needs deploy, STOP and report BLOCKED"). Every task after Task 2 honored it (build-only). Do the
same for any future dispatched implementer on this repo.

---

## THE V2→V3 MIGRATION (DONE + VERIFIED on mainnet)

Adding fields enlarged the account. 264 V2 vaults existed; 23 had `active_session=Some` under the
OLD 92-byte session layout (289-byte accounts) → the enlarged program can't deserialize them
(Anchor loads the whole `Account<Vault>` on entry, incl withdrawal paths — so a short vault is
FROZEN until migrated). Branch confirmed ALL are TEST VAULTS (~$1 each), so no real-fund risk.

`migrate_v2_to_v3` instruction (commit 7284985): takes the vault as `AccountInfo` (NOT typed —
avoids deserialize-on-entry failing on the short buffer), validates discriminator + version==2 +
owner, manually prefix-decodes to check `dexter_authority` signer (stops before active_session so
it never over-reads), `AccountInfo::resize(+16)` zero-fills the trailing 16 bytes (which land
EXACTLY at current_outstanding=0 + max_revolving_capacity=0 because they're the last two fields of
the last struct — verified correct), rent top-up CPI, bumps version 2→3. Legacy Some-sessions get
max_revolving_capacity=0 (revoke+re-register for a real cap — documented, accepted).

**Migrated + VERIFIED 2 of the 23 (the only 2 we control the authority for):**
- `2RSj1UiBqnrzGLeELciboHmSxjqL1EaSks2j9iw5JsfZ` (authority = upgrade wallet) — version-bump
  case (already 305B). sig `3XJHQ4Tq...`. → v3, fields intact. ✅
- `EVuq1VpeynsJYdBzniRYCMx9fo4r5MXKHjtZcSS3tMX2` (authority = prod session-master
  `3SWJTQ4FB...`) — REALLOC-GROW case (genuine 289B short vault). sig `4xSXCyN5...`.
  → 289→305B, v2→v3, **existing session PRESERVED** (max_amount/expires/nonce/spent intact),
  new fields zero-filled. ✅ This proved the hard realloc path works on a real vault.
- The other **21 are throwaway-key test vaults** (each test run minted a random ephemeral
  `dexter_authority`) — we can't sign their migration, accepted as stale junk. They're frozen
  but it's $1 test money. NOT a problem.

### Custody check (CONFIRMED non-custodial, intact)
Production uses ONE shared session-master (`DEXTER_SESSION_MASTER_KEY` in dexter-facilitator/.env,
pubkey `3SWJTQ4FB...`). `dexter_authority` (session master) can ONLY tick the counter + relay
user-signed vouchers + run migration (resize+version) — it CANNOT withdraw (withdrawal needs the
user's PASSKEY via secp256r1). So holding the session-master ≠ custodian. The upgrade changed
nothing about this. Even a runaway subagent + us holding the master could never move user funds —
the architecture bounded every mistake to operator-level actions. **Still fully non-custodial.**
Real production vaults all share the one master we control → any future short-vault is migratable.

---

## REMAINING: Task 7 — the turnover demo (the 5x proof) — NOT YET RUN

This is the ONLY thing left, and it's BOTH the demo AND the first real mainnet test of the meter
LOGIC (capture/release seams have been deployed but never exercised on-chain — migration was,
meter wasn't).

**What to do:** write/run `tests/turnover-demo.ts`:
- `registerSettleableVault(program, provider, {maxAmount: 100_000_000, maxRevolvingCapacity: 2_000_000})`  ($2 cap)
- loop 10×: `open(... 1_000_000)` ($1 → current_outstanding rises) then `settle(... cumulative, ctx)` ($1 → current_outstanding falls to 0)
  — NOTE the cumulative-voucher model: each settle carries the RUNNING total, so round i settles cumulative = i*1_000_000.
- assert: `spent == 10_000_000`, `current_outstanding == 0`, `turnover = spent/capacity = 5x > 1`.
- print `CREDEX PROOF: settled=$10 capacity=$2 turnover=5x`.

**Reality of running it:** real mainnet, ~20+ txs (~13s each), ~0.05-0.1 SOL, ~5-8 min. Wallet has
~2.4 SOL, fine. Helpers already exist in `tests/revolving-meter.ts` (lean `registerSessionWithCapacity`,
heavy `registerSettleableVault`, `open`, `settle`) from Tasks 4/8 — turnover-demo reuses them
(or extract to tests/helpers/revolving.ts). Test env: `ANCHOR_WALLET=~/.config/solana/dexter-vault/upgrade-authority.json`,
`ANCHOR_PROVIDER_URL=https://api.mainnet-beta.solana.com`, PATH needs
`~/.local/share/solana/install/active_release/bin`. Tests run against MAINNET (secp256r1 precompile
is mainnet-only — there is NO local validator path; that's settled, don't relitigate). Node fetch
needs sandbox disabled (curl works under sandbox, fetch doesn't).

**If the meter logic has a bug, this is where it surfaces** — that's good, it's the point. Capture
(settle_voucher) and release (settle_tab_voucher) get their first real exercise here.

---

## ALSO PENDING (Thread B — separate, after Task 7): make the CLIENT STACK V3-consistent

The deployed program is V3/188-byte-registration. The SDK/facilitator/seller-verify are still
V1/180-byte. So tab-OPEN through the real SDK currently BREAKS on mainnet (program expects V2/188 +
maxRevolvingCapacity arg; SDK sends V1/180 without it). This is a LATENT inconsistency (no real
users, per Branch) — must be fixed before the system is usable end-to-end, but it's not urgent.
Files to update to V2/188 + pass maxRevolvingCapacity:
- dexter-x402-sdk/src/tab/messages.ts (builds the 180-byte msg)
- dexter-x402-sdk/src/tab/seller/verify.ts (hard-rejects != 180; domain V1)
- dexter-x402-sdk/src/tab/adapters/solana/index.ts, sessions.ts, passkey-noble.ts
- dexter-facilitator (wherever it builds the registration message / register args)
- dexter-vault tests/register-session-key.ts (its V1 ceremony is broken — pre-existing tsc error)
Decision already made: ROLL FORWARD to V3 (not roll back). Do Thread B AFTER Task 7 verifies the
program, so the client matches the FINAL program in one pass.

---

## NAMING CANON (Branch-confirmed, do not relitigate)
- **OTS** = the standard. **Vault** = the enabling substrate program (enables tabs AND future
  credit — NO rename; "vault" = vault of authority/encumbrance, funds stay in user's wallet).
  **Tab** = the instrument. **Credit** = the third thing built on the Vault. **Endow** = the
  authority layer (passkey/SIWX). The credit ladder: rung1 self-collateralized (=the meter,
  shippable), rung2 deferred-settlement, rung3 guaranteed (=becomes lending, regulated — fix
  separately, NOT in docs), rung4 reputation (needs identity layer; Branch is skeptical of its merit).
- `settle_voucher` is NOT legacy — it's the on-chain tab-OPEN instruction (open half of open/close).
  `settle_tab_voucher` is the value-moving close. Two halves, not a conflict.

## STRATEGY DOC (separate, lives elsewhere)
The Endow-EVM / Solana-structural-advantage thesis (no-escrow+no-rug is a Solana-native property;
EVM needs self-escrow; 7702 root-key can always override) lives at
`dexter-decks/thesis/2026-06-02-endow-evm-architecture-and-solana-clearing-advantage.md` (v3,
emailed to Branch). NOT in dexter-vault. Don't confuse the two doc homes.

## DESIGN LESSON (permanent, for the security doc)
Withdrawal paths use typed `Account<Vault>` → Anchor deserializes the WHOLE struct on entry → any
future struct-size change FREEZES mid-session vaults until migrated. RULE: migrate-before-deploy,
OR make load paths size-tolerant. The shared-session-master means production is always migratable.

---

# ===== NEXT SESSION STARTS HERE: THREAD B (the gate) =====

## The two-agent state (2026-06-05, synced)
Two Claude sessions collaborated and ALIGNED. The other agent (the dexter-facilitator session)
owns **Phase 1 / LockedClaim** (vault-level reservation: `lock_voucher`, `transfer_lock_ownership`,
`settle_locked_voucher`, `recover_abandoned_lock` + `vault.outstanding_locked_amount` accumulator).
Spec = `dexter-thesis/V0.3-IMPLEMENTATION-RISK-DECISIONS.md`. Full synthesis (READ THIS) =
`dexter-thesis/SYNTHESIS-2026-06-05-credex-meets-lockedclaim.md`. The other agent is ON HOLD per
Branch — do NOT solicit him; this session leads. The two accumulators are the same pattern at two
altitudes: my `session.current_outstanding` (revocable tier) graduates to his
`vault.outstanding_locked_amount` (crystallized tier) at lock time.

## SEQUENCING (decided): Thread B GATES Phase 1.
Tab-open through the live SDK is BROKEN today (program=V2/188, SDK=V1/180). Phase 1 needs a working
tab to produce a lockable voucher → so B must land first. Phase 1 Rust can be WRITTEN in parallel
(build-only) but its e2e-test + deploy wait for B green. **This session: DO THREAD B.**

## THREAD B — exact work order (start here, execute surgically)

**Goal:** bring the client stack from V1/180-byte to V2/188-byte registration so tab-open works
against the deployed mainnet program. Then verify a real tab open→settle on mainnet.

**The byte-layout change** (V1→V2), authoritative source = dexter-vault register_session_key.rs:118-131:
```
[  0..32) domain "OTS_SESSION_REGISTER_V2\0...\0"   (was V1; 23 chars + 9 NUL = 32)
[ 32..64) program ID
[ 64..96) vault PDA
[ 96..128) session_pubkey
[128..136) max_amount u64 LE
[136..144) expires_at i64 LE
[144..176) allowed_counterparty
[176..180) nonce u32 LE
[180..188) max_revolving_capacity u64 LE   <-- NEW (the only addition)
```
Also: `register_session_key` now takes a NEW arg `max_revolving_capacity: u64` (must be > 0, else
`RevolvingCapacityZero`). Callers must pass it.

**Files to update (SDK = dexter-x402-sdk/src/tab/):**
1. `messages.ts` — builds the registration message. Change 180→188, append max_revolving_capacity
   u64 LE, domain V1→V2. (THE core change.)
2. `seller/verify.ts` — HARD-rejects `length !== 180` and checks domain `OTS_SESSION_REGISTER_V1`.
   Change to 188 + V2 + parse the new field into the scope.
3. `adapters/solana/index.ts`, `sessions.ts`, `passkey-noble.ts`, `index.ts` — all reference the
   180-byte layout / build the register call. Update to 188 + pass maxRevolvingCapacity through the
   register-session call.
**Facilitator (dexter-facilitator/src/):** `tabSettle.ts`, `mppSession.ts` — wherever they build the
registration message / register args, same V2/188 + maxRevolvingCapacity update.
**@dexterai/vault SDK byte-parity tests (dexter-vault-sdk/):** `src/messages/session.ts` +
`tests/byte-parity.test.ts` (+ `src/constants/index.ts` for the domain) — update to 188-byte V2 so
parity passes against the deployed program. The other agent flagged: these byte-parity tests are
the right place to catch the drift.
**dexter-vault tests/register-session-key.ts:** still builds V1/180 (pre-existing tsc error noted in
this session). Migrate its ceremony to V2/188 too (it's currently broken).

**Verify B is green:** a real tab open→settle on mainnet through the updated SDK. THAT is the gate
for Phase 1 e2e.

**Discipline reminders for any subagents:** HARD no-deploy fence in caps (the Task-2 incident).
Build-only = compile/type-check, NO mainnet deploy without Branch's explicit per-step go. Don't
touch Branch's uncommitted docs. Tests run on MAINNET (secp256r1 precompile is mainnet-only; no
local validator — settled). Node fetch needs sandbox disabled (curl works under sandbox; fetch
doesn't) → use dangerouslyDisableSandbox on mainnet RPC calls.

## AFTER THREAD B: Phase 1 prep notes (for when we get there)
- Phase 1 task #1 = `migrate_v3_to_v4` (the other agent ACCEPTED this — he'd missed it). His
  Decision-1 adds THREE u64s to Vault (`outstanding_locked_amount`, `total_crystallized_amount`,
  `total_settled_amount`) → enlarges account again → needs V4 + migration. TEMPLATE = my
  `migrate_v2_to_v3` (this repo, commit 7284985): AccountInfo not typed, resize +24, zero-fill
  trailing, manual-prefix-decode authority gate, rent top-up. His `finalize_withdrawal` reservation
  check reads the new u64s from typed `Account<Vault>` → every vault must be V4-migrated first.
- Named test invariant he accepted: a voucher amount flows down EXACTLY ONE terminal path —
  lock_voucher XOR tab-settle, never both. `crystallized_cumulative` (new field) is DISTINCT from
  my `spent`. spent = tab-close settles; crystallized = locks.
- Tighten the turnover-demo assertion `>1` → `>= ROUNDS*CLAIM/REVOLVING` (one-liner, my TODO).

# ===== THREAD B PROGRESS (2026-06-05 afternoon) =====

Thread B (client stack V1/180 → V2/188) executed subagent-driven, opus, TDD, two-stage
review per task. Plan: `dexter-vault-sdk/docs/superpowers/plans/2026-06-05-thread-b-v2-registration.md`.

**7 of 8 tasks DONE. Only Task 8 (live mainnet tab — THE GATE) remains.**

Shipped (all commits LOCAL/UNPUSHED on `main` in each repo):
- **@dexterai/vault**: V2 domain const, 188-byte sessionRegisterMessage, register ix carries
  max_revolving_capacity (Borsh after nonce), SessionScope.revolvingCapacityAtomic (optional).
  **PUBLISHED to npm: 0.4.0 then 0.4.1** (Branch authorized both publishes). 34/34 parity tests green.
- **dexter-x402-sdk**: seller verify.ts parses V2/188 + maxRevolvingCapacity; adapter passes it to
  both builders (default `?? maxAmountAtomic`); openTab gained optional `revolvingCapacity` (human
  units, defaults to totalCap); dep bumped ^0.4.1. tsc clean, 280/280 tests green.
- **dexter-facilitator**: REGISTRATION_MIN_LENGTH 180→188 + dep bump. (Branch has OTHER uncommitted
  work here — internalSign.ts/config/docs — NOT touched.)

**Design decision (Branch-approved): revolving cap is OPTIONAL, defaults to totalCap.** Ships the
capability now, obligation opt-in, surfaces the credex lever in the API (`revolvingCapacity` below
totalCap = force turnover>1). Field lives at 3 layers: openTab `revolvingCapacity` (human) →
SessionScope `revolvingCapacityAtomic` (atomic) → adapter `maxRevolvingCapacity` (bigint) → program.

**Custody check held under scrutiny (Branch asked):** session keys are MEMORY-ONLY and that
STRENGTHENS non-custody (no persisted spending key = nothing to custody). Passkey is the custody
root (only it can withdraw). Full reasoning saved to memory `vault-noncustody-session-keys`.

**FORWARD NOTES (documented in code, repeated here so they survive):**
- Phase 3 `resumeTab` (dexter-x402-sdk/src/tab/tab.ts, currently a deliberate throw-stub): when
  implemented, READ max_revolving_capacity from chain (verify.ts parseRegistration returns it), do
  NOT re-supply it, and NEVER persist/recover a session key — re-prompt passkey for a fresh one.
  Breadcrumb is in the resumeTab() comment.
- `ResumeTabOptions` will eventually want the same optional `revolvingCapacity` field openTab got
  (today it relies on the adapter `?? maxAmountAtomic` default — safe, not a bug).
- Polish already applied (commit 919d8de): early `revolvingCapacity > 0` guard at openTab, dropped a
  redundant `BigInt().toString()`.

**TASK 8 (THE GATE) — what's left:** prove a real V2/188 registration is accepted by the LIVE mainnet
program through the updated SDK. Baseline `npm run prove:credex` (in dexter-vault) already does V2/188
register+settle on mainnet and PASSED — so the program side is proven; Task 8 proves the SDK-driven
path. Also fix dexter-vault/tests/register-session-key.ts (pre-existing V1/180 tsc error) to V2/188.
MAINNET, ~SOL, sandbox-disabled fetch. NO program deploy (program is already correct). After green:
Thread B unblocks Phase 1 / LockedClaim e2e.

**PUSH STATUS:** Thread B commits are UNPUSHED across vault-sdk / x402-sdk / facilitator (Branch's
call). NOTE: @dexterai/vault 0.4.0+0.4.1 ARE published to npm (public) even though git is unpushed.

## QUICK ORIENTATION FOR NEXT SESSION
- Credex meter: DONE, mainnet, 5x proven. 9 commits c2e661b..163bbbc, UNPUSHED (Branch's call to push).
- Strategy thesis (Endow-EVM/Solana clearing advantage): dexter-decks/thesis/2026-06-02-endow-evm-*.md
- This session id: e0a2c1c7-7ff1-4886-8a50-cbdb68d0883b
- Wallet: ~/.config/solana/dexter-vault/upgrade-authority.json (~2.4 SOL). Env for tests:
  ANCHOR_WALLET=that, ANCHOR_PROVIDER_URL=https://api.mainnet-beta.solana.com,
  PATH+=~/.local/share/solana/install/active_release/bin.
