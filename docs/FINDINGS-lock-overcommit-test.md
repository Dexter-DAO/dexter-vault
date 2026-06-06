# FINDINGS: the `lock_voucher` over-commit test — problem, analysis, leanings

**Author:** credex/vault Claude. **Date:** 2026-06-06. **Status:** FOR PEER REVIEW — no decision made, no test rewritten pending review.

**Why this doc exists:** The property under test ("the vault can never owe more locked claims than it actually holds in USDC" — a load-bearing anti-rug guarantee) is too important to test half-assed. Branch asked for a detailed write-up so a peer reviewer can judge whether my proposed simplification is sound or whether the heavier mechanism is genuinely required. This doc documents what I found, the math, the existing coverage, and my (uncertain) leaning. **It deliberately makes the case BOTH ways.**

---

## 1. THE PROPERTY WE ARE TRYING TO PROVE

`lock_voucher` has a self-check (the "over-commit guard", G3), at `programs/dexter-vault/src/instructions/lock_voucher.rs:218-228`:

```rust
// V0.3 Decision 1 self-check: post-lock outstanding must not exceed live USDC balance.
let proposed_outstanding = vault.outstanding_locked_amount.checked_add(delta)
    .ok_or(VaultError::LockWouldOvercommitVault)?;
require!(
    proposed_outstanding <= ctx.accounts.vault_usdc_ata.amount,  // LIVE balance read
    VaultError::LockWouldOvercommitVault
);
```

Plain English: **a lock cannot push the total outstanding locked amount above the real USDC the vault holds right now.** This is one of the three anti-rug guards (the other two: `finalize_withdrawal` reservation check, `register_session_key` overcommit check). Together they enforce the thesis: *the buyer can never reach a state where a locked claim is unbacked.*

The failing test (`tests/lock-voucher.ts`, describe "lock_voucher — over-cap rejection") tries to prove G3 *rejects* an over-committing lock.

---

## 2. THE PROBLEM (why the test failed, and why my first two fixes were wrong)

`lock_voucher` runs THREE guards in order; to reach G3 you must pass G1 and G2:

| # | Guard | Code (lock_voucher.rs) | Rejects with |
|---|---|---|---|
| G1 | **frontier (XOR)** | `cumulative_amount > max(spent, crystallized_cumulative)` (line 174) | `LockRangeAlreadyClaimed` |
| G2 | **cap** | `cumulative_amount <= session.max_amount` (line 178) | `InvalidVoucherSignature` |
| G3 | **over-commit** | `delta + outstanding_locked_amount <= live_balance` (line 226) | `LockWouldOvercommitVault` |

Plus the **registration gate** (`register_session_key.rs:167`): `max_amount + outstanding_locked_amount <= vault_usdc_ata.amount` at register time. So a session's `max_amount` can never exceed the balance *at registration*.

**The original test failed** because its fixture funded $1 but registered a $5 cap → the *registration gate* rejected it (`SessionWouldOvercommitVault`) before the test ever reached a lock. (This is the gate working correctly.)

**My fix attempt #1** (voucher $3 vs cap $2): wrong — `cumulative_amount $3 > max_amount $2` trips G2 (`InvalidVoucherSignature`), not G3.

**My fix attempt #2** (two locks, $3 + $3 on a $5 vault): wrong — proven impossible by algebra below.

---

## 3. THE ALGEBRA (this is the crux — G3 is UNREACHABLE without a balance drop)

To make G3 fire on a lock with cumulative `c`, in a session with cap `M`, vault balance `B`, current `outstanding = O`, `crystallized = X` (so `delta = c - X`):

- **G1 requires:** `c > max(spent, X)` → in particular `c > X`
- **G2 requires:** `c <= M`
- **Registration required:** `M + O_at_register <= B_at_register`
- **G3 fails (what we want) iff:** `delta + O > B` → `(c - X) + O > B`

For a **single session with a stable balance**, walking the locks: after locks summing to `O`, we have `X = O` (crystallized tracks the locked total). So `delta + O = (c - X) + O = (c - O) + O = c`. **G3 fails iff `c > B`.** But G2 requires `c <= M`, and registration required `M <= B`. Therefore `c <= M <= B`, so **`c <= B` always** → **G3 can NEVER fail.**

**CONCLUSION: With a single registered session and a balance that has not dropped since registration, the over-commit guard G3 is mathematically unreachable.** The cap guard (G2) + registration gate together guarantee solvency, so G3 never has anything to catch.

**G3 can ONLY fire when the live balance DROPS after registration** — i.e. the vault is funded, a session is registered, then USDC leaves the vault (legitimately via settle, or via a withdrawal that itself is gated), and *then* a lock is attempted against the now-lower balance. This is exactly the spec's stated rationale (V0.3 Decision 1, the lock check note): *"the vault's balance fell between the session's registration time and the lock attempt."*

---

## 4. THE COMPLICATION (why testing the balance-drop is heavy)

To make the balance drop, USDC must leave the vault's USDC ATA. **That ATA is owned by the `swig_wallet_address` PDA, not the test wallet** (`registerSettleableVault`/`bootstrapForRegister` create it `allowOwnerOffCurve` under the swig wallet). So you cannot drain it with a plain SPL transfer — moving USDC out requires the **Swig `SignV2(TransferChecked)` ceremony**, the same heavyweight machinery `settle_tab_voucher` uses (see `tests/revolving-meter.ts:460` `getTransferCheckedInstruction` + the SignV2 wrapper). `tests/lock-voucher.ts`'s current helper (`enrollLockableVault`) does NOT wire the settle/SignV2 path; only `revolving-meter.ts`'s heavy `registerSettleableVault` does.

So an honest G3-rejection test needs one of:
- **(A)** fund → register → **settle part of the tab** (real USDC leaves via SignV2, balance drops) → attempt a lock the lower balance can't back → expect `LockWouldOvercommitVault`. Faithful, but pulls in the full settle apparatus.
- **(B)** fund → register → **Swig-signed raw transfer out** of the ATA → lock → expect reject. Slightly less "real" but same drain effect; still needs SignV2.

Both are real work and real machinery.

---

## 5. EXISTING COVERAGE (what is ALREADY proven elsewhere — the redundancy question)

This is the heart of the review decision. Reading the sibling tests:

### `tests/finalize-withdrawal-reservation.ts`
- **lock happy-path IS exercised:** funds $10, `openTab`, **`lockAmount($5)` succeeds** (line 151-152) — so `lock_voucher` graduating into a LockedClaim and incrementing `outstanding_locked_amount` is proven working here as a precondition.
- **reject case (line 141):** funds $10, locks $5, attempts withdrawal of $7 → `WithdrawalWouldViolateReservation`. **This proves the anti-rug solvency property via the WITHDRAWAL vector** — the buyer cannot pull funds below the locked amount.
- **permit case (line 174):** funds $10, locks $3, withdraws $5 → reservation gate does NOT fire (correctly allows it).

### `tests/register-session-overcommit.ts`
- Both cases (per header lines 17-22) drive a **real lock_voucher** to seed `outstanding_locked_amount > 0`, then a passkey revoke, then a second `register_session_key` whose `max_amount + outstanding` is/isn't within the live balance → proves `SessionWouldOvercommitVault` fires/doesn't. **This proves the anti-rug solvency property via the REGISTRATION vector.**

### `tests/lock-voucher.ts` (the file in question)
- **happy path + XOR Tests 1 & 2 PASS on mainnet** (the graduation works, double-spend rejected both directions).
- The **over-cap rejection** case is the only one in question.

**Coverage summary of the "vault stays solvent / buyer can't un-back a claim" property:**

| Attack vector | Guard | Test that proves rejection | Status |
|---|---|---|---|
| Withdraw below locked | `finalize_withdrawal` reservation | finalize-withdrawal-reservation.ts (reject) | ✅ covered |
| Register over-committing session | `register_session_key` overcommit | register-session-overcommit.ts (reject) | ✅ covered |
| **Lock beyond balance** | **`lock_voucher` over-commit (G3)** | **lock-voucher.ts (over-cap) — THE ONE IN QUESTION** | ❌ failing/unbuilt |
| lock graduation works | lock_voucher happy | lock-voucher.ts (happy) + others use lockAmount | ✅ covered |

---

## 6. MY LEANING (stated with explicit confidence, and the case AGAINST it)

**Lean (~65% confidence): the G3-in-isolation rejection test, as currently framed, is partially redundant — BUT it is NOT fully covered, and I do NOT recommend simply deleting/weakening it.**

Here's the nuance the coverage table reveals: the *other two* anti-rug guards (withdrawal, registration) have explicit reject tests. **G3 (the lock's own self-check) is the ONE solvency guard with no dedicated rejection test.** The happy path of lock works (proven many places), but the specific assertion "a lock that would overcommit is REJECTED" is currently unproven on-chain.

So there are two honest positions for the reviewer to weigh:

**Position X — "build the real thing" (the drain test, option A above):**
- G3 is a distinct guard at a distinct instruction. The other two tests prove *different* instructions' guards. Defense-in-depth means each guard should have its own rejection proof. The thesis ("buyer can't rug seller") is THE product claim; leaving one of three anti-rug guards without a rejection test is a real, demonstrable gap — exactly the "half-assed in this area" Branch is worried about.
- Cost: wire the settle/SignV2 drain into lock-voucher.ts (or reuse revolving-meter.ts's heavy harness). Real work, ~1 focused task.
- This is the conservative, thesis-protecting choice.

**Position Y — "it's redundant enough" (simplify, rely on siblings):**
- The *underlying invariant* (`outstanding <= balance`) is the same math checked at all three instructions. The withdrawal + registration reject tests already prove the vault refuses to let outstanding exceed balance. Per the algebra, G3 only fires on a balance-drop, which is an unusual operational state. The happy-path lock is well covered.
- Cost: change lock-voucher.ts's over-cap case to assert something reachable (e.g. that a lock within balance succeeds, or remove the impossible-without-drain reject and document why).
- Risk: this is the convenient answer, and "convenient" is suspect when the alternative is "more work." **A reviewer should weigh whether I'm rationalizing.**

**My actual recommendation:** lean toward **Position X (build the drain test)** — NOT because the math says G3 is reachable in normal flow (it isn't without a drop), but precisely because **the balance-drop-then-lock IS the rug scenario** (buyer funds, gets authorized, drains, tries to crystallize an unbacked claim), and proving the program stops it on-chain is exactly the demonstration Branch wants for the core thesis. The redundancy argument (Y) is real but weaker than the "each anti-rug guard deserves its own on-chain rejection proof" argument (X). I am ~65% on X, and I flag my own ~35% pull toward Y as the suspicious-because-convenient direction.

**Answer to "is Branch demanding the impossible?": No.** The property is provable. G3-in-isolation requires a balance-drop to trigger (that's a fact of the guard's design, not a limitation), and the balance-drop is buildable via the existing settle/SignV2 machinery. It's more work, not impossible work. The only thing that was "impossible" was my naive single-session two-lock idea — which the algebra correctly killed.

---

## 7. WHAT I HAVE NOT DONE (and am not doing until review)
- Not rewritten the test (the current uncommitted edit in lock-voucher.ts is my WRONG two-lock attempt — it should be reverted regardless of which position wins).
- Not decided X vs Y.
- Not run anything on mainnet for this.

## 8. CONCRETE NEXT STEPS (pending reviewer's X-or-Y call)
- **If X:** revert my bad edit; build the drain-then-lock test (fund → register → settle-partial via SignV2 → lock beyond remaining balance → assert `LockWouldOvercommitVault`), reusing revolving-meter.ts's settle harness. Run on Helius.
- **If Y:** revert my bad edit; reframe the over-cap case to a reachable assertion + document the algebra (G3 unreachable without balance-drop) inline, citing the sibling tests that cover the invariant.

---

## ADDENDUM (2026-06-06): lock-without-open is permitted — metrics flag, NOT a safety hole

While fixing the finalize_withdrawal reject test we confirmed: `lock_voucher` does NOT
require a prior open (`current_outstanding -= delta` uses `saturating_sub`, clamping to
zero), and does NOT touch `pending_voucher_count`. So a seller can lock a claim that never
passed through the revocable meter tier.

**Safety: fully intact.** Every fund guard fires regardless of the open — cap
(`cumulative <= max_amount`), over-commit (`outstanding + delta <= live balance`), frontier
(XOR), and the session signature. No rug, no over-authorization, no double-spend, no forgery
is enabled by lock-without-open.

**Residual: metrics/semantics looseness only.** Exposure can skip `current_outstanding`, so
the credex meter and the velocity/turnover figure it feeds could under-report or be gamed by
a seller who locks without opening. This matters ONLY if the velocity number must be
tamper-proof (investor deck / underwriting / indexer credit-graph integrity).

**Decision for the other agent (design, not bug):** should `lock_voucher` require the
exposure to have been opened first — i.e. `checked_sub` (reject lock if `current_outstanding
< delta`) instead of `saturating_sub`? `saturating_sub` is the permissive choice and was
deliberate (stranded-lock comment). Tightening enforces "you can only crystallize what you
opened," at the cost of rejecting some edge flows. LOW severity; capture as a choice.
