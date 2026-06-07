# Alpha → Zeta — the grand build map

**The whole arc, from where we genuinely are to "we're open for business." Milestones in order, what's DONE / NEEDS A PLAN / NEEDS GTM, and which milestones need their own detailed plan (those plans are a separate step, not written here).**

**Zeta = the achievable business.** The day we say: *"We've done it. We're open. Here's exactly what we do — non-custodial agent payments and agent credit, the clearing layer the inference economy charges through."* Not the 2040 substrate vision — the working credit-and-clearing network with real financiers and real agents.

**A-to-Z** (`dexter-thesis/A-TO-Z-HOLY-SHIT-DEMO.md`) is ONE chapter inside this — the LockedClaim chapter (Δ below). This doc is the wider arc A-to-Z sits in.

*Status legend:* ✅ DONE · 🔧 NEEDS A PLAN (a detailed task-plan like the meter/LockedClaim plans) · 🌐 NEEDS GTM (partnership/market work, not code) · 📐 NEEDS DESIGN LOCK (decisions before a plan can be written)

---

## Α — Alpha · Custody + Clearing — ✅ DONE (on mainnet, today)

The two firsts. The foundation everything rides on.

- ✅ Sole-passkey custody — only the passkey moves funds out, no bypass key on the spend path; real USDC withdrawal on mainnet.
- ✅ The revolving capacity meter — `current_outstanding` + `max_revolving_capacity`; capture seam (`settle_voucher`), release seam (`settle_tab_voucher`); V3, deployed mainnet (slot 424482413).
- ✅ The 5× turnover proof — same $2 cleared $10 on mainnet, ~20 real txs, vault `3Af4F7vH...`.

**What Alpha is NOT:** credit. The $10 that revolved was the user's OWN money clearing repeatedly — velocity of own capital, not lending. Nobody lent anybody anything yet.

---

## Β — Beta · The Drift Fix (Thread B) — ✅ DONE (verified green on mainnet, 2026-06-05)

The unsexy gate, now closed. The deployed program speaks V2/188-byte registration; the SDK / facilitator / seller-verify stack was still on V1/180 — so tab-open through the real SDK was broken against the live program. **Fixed across the whole stack and verified on mainnet.** The cork is out of the bottle: tab-open through the published SDK now works against the live program, which unblocks Γ and Δ.

- ✅ `@dexterai/vault` — builds the 188-byte V2 message, carries `max_revolving_capacity`, published **0.4.1** (domain separator → 188-byte builder → ix arg → `SessionScope.revolvingCapacityAtomic`).
- ✅ `dexter-x402-sdk` — seller `verify.ts` parses V2/188; `openTab → scope → register` plumbs `revolvingCapacity` (defaults to total cap); bumped to `@dexterai/vault ^0.4.0`; V2 test green.
- ✅ `dexter-facilitator` — registration min length 180→188; pinned `@dexterai/vault ^0.4.1` (uniform across stack).
- ✅ Verified: commit `531053f` — "register-session-key uses published @dexterai/vault 0.4.1 SDK — **V2/188 green on mainnet**." Tab registration through the real published SDK works against the live program.

Mechanical (a known byte-layout bump), not design work. **This is the hard gate before Γ and Δ.** (Flagged by credex/vault Claude; was in-progress same day.)

---

## Γ — Gamma · Real-Agent Organic Turnover — 🔧 NEEDS A PLAN + 🌐 partially GTM

The proof that flips turnover from "Branch drove a loop on mainnet" to "real agents drove it." This is the *investable* artifact — it answers the killer VC question "did you generate this, or did the market?"

- Route already-existing real agent traffic (OpenDexter / MCP / dexter-phone) through a credex-metered vault on mainnet.
- Confirm the facilitator passes a real per-tab commitment `amount` to the meter (credex plan flagged `vaultPendingVoucher.ts` may currently pass `deposit_atomic` — needs to pass the real commitment).
- Accumulate organic settlements → compute turnover from traffic nobody hand-generated → clickable Solscan receipts.

Depends on Β (the SDK tab-open must work). The agent surfaces already exist, so the "real demand" is real traffic we already have — this is routing, not building a market from zero.

---

## Δ — Delta · LockedClaim — the transferable claim (THE A-TO-Z CHAPTER) — ✅ DONE (deployed + full suite green on mainnet, 2026-06-06)

The rails credit runs on. Turns a revocable voucher into a transferable, buyer-irrevocable, collectible on-chain claim — the thing a financier can BUY.

- `lock_voucher` → `LockedClaim` PDA (the accepted voucher becomes an independent asset).
- `transfer_lock_ownership` (sell the claim) + `settle_locked_voucher` (financier collects).
- The three attack-failures on mainnet (revoke / withdraw / overcommit all rejected, red on Solscan).
- The accumulator that pairs with the meter: `vault.outstanding_locked_amount` (the crystallized, buyer-IRrevocable tier) vs. `session.current_outstanding` (the revocable tier). Exposure *graduates* from revocable to crystallized when it locks.

**SHIPPED 2026-06-06.** Program `Hg3wRaydFtJhYrdvYrKECacpJYDsC9Px7yKmpncj2fhc` upgraded to 19
instructions (+4 LockedClaim + migrate_v3_to_v4), upgrade sig `36KX827g…`. The full suite is GREEN
on mainnet (16 passing): the three attack-failures (lock over-commit / withdraw-reservation /
register-overcommit) are each proven with a real failed transaction, plus XOR double-spend (both
directions) and the full financier lifecycle (transfer / settle / recover). Receipts + scorecard:
`docs/superpowers/PICKUP-2026-06-06-phase1-complete.md`. The 5× turnover proof re-verified green
after tightening to `==5x` exact (vault `GprV3ySM…`).

**Both A-to-Z gaps closed:** (1) the **V3→V4 account-size migration** was built (`migrate_v3_to_v4.rs`,
decode-V3 / re-encode-V4) — 435 V3/older vaults still work via the V4‖V3‖V2 version gates;
migration only needed before a typed reservation read on a given vault. (2) **Q-OPEN-1 locked:**
`crystallized_cumulative` is a distinct field from `spent`, and the XOR invariant (a voucher flows
down exactly ONE terminal path — lock XOR tab-settle, never both) is enforced on-chain by the shared
frontier guard `cumulative > max(spent, crystallized_cumulative)`.

**What's LEFT to fully ship (gated to Branch, not blocking):** publish `@dexterai/vault` 0.4.2
(audited correct, parked), migrate the controllable V3 vaults, push. See the pickup doc.

Δ is DONE — which design-unblocks **Ε** (its account shape, `outstanding_locked_amount` +
`crystallized_cumulative`, is now final on mainnet).

---

## Ε — Epsilon · Credit — the financier mechanism — ✅ BUILT + TESTED (mainnet; real third-party loan imminent)

The lending rung — built. **This is where lending actually happens** — a financier posts standby capital so an agent can spend BEYOND the user's locked funds. (Mechanism in `PICKUP-EXAMPLE-how-agent-credit-works.md`.) Built on Δ's locked account shape (`outstanding_locked_amount`), V5 vault.

The four credit instructions (all on disk, all tested green against mainnet):
- **`open_standby`** — a financier commits a ceiling (`standby_cap`, `standby_backer`) onto the USER's vault. USER passkey-gated: the op-message binds vault + financier + cap, so a consent can't be replayed against a different vault/backer/cap.
- **`draw_credit`** — THE BORROW. Draws USDC from the FINANCIER's vault to the seller, raises `vault.borrowed`, arms the recovery deadline. **The cap guard lives here** (`borrowed + amount ≤ standby_cap`, checked_add first) — unbypassable, the only borrow path.
- **`repay_credit`** — THE PAYDOWN. User repays the financier, lowers `borrowed`, clears the recovery deadline (unpins) at exactly zero. Clamps to outstanding — never over-repays.
- **`seize_collateral`** — THE LIQUIDATION. After `borrow_recovery_at` passes, the financier reclaims the pinned slice from the user's collateral. Mirror of `recover_abandoned_lock`. The deadline guard runs BEFORE any mutation — the financier cannot seize one second early.
- **The collateral pin** (`finalize_withdrawal.rs:115`) — `reserved = outstanding_locked_amount + borrowed`; a withdrawal that would dip into an open loan is rejected (`WithdrawalWouldViolatePin`). This is the firsts-in-action: the user authorizes once, the chain pins it — sovereign AND bound. Even the user's own passkey can't pull collateral out from under the lender.

**Tested green on mainnet:** cap-guard (over-cap draw rejected), pin-breach (withdraw-below-borrow rejected), early-seize rejected, open_standby consent + replay-binding rejected, the full open→draw→repay lifecycle (real USDC financier→seller→back), and seize-after-deadline (USER→financier). The one red across runs was a test regex mismatch, fixed; the program logic was never wrong.

**The ONE thing left:** a real loan with an EXTERNAL financier on mainnet — standby capital from someone other than us. Imminent, before the deck ships. Everything the loan needs is built and tested; this is exercising it with a real counterparty, not building it.

Depends on Δ.

---

## Ζ — Zeta · Open For Business — the clearing-and-credit network — 🌐 mostly GTM

"We've done it. We're open. Here's exactly what we do."

- A real financier (institution / yield pool / Dexter's own balance sheet) plugged into Ε, lending against real vaults.
- Real agents spending on credit through real inference providers (the providers charge through us).
- **The credit graph** — repayment history accumulating into something lenders price risk against. (Begins compounding the moment Ε settles its first real loan.)
- The public statement of what Dexter IS, now demonstrable end-to-end: *non-custodial agent payments + agent credit, the clearing layer the inference economy runs on.*

This is less "build" and more "the build is done, now we go get the financiers and the inference providers and we say it out loud." The code arc terminates at Ε; Ζ is Ε running with real counterparties on both sides.

---

## The dependency spine (the order, even where plans don't exist yet)

```
Α (done) ──► Β (drift fix, the gate) ──┬──► Γ (real-agent turnover — the investable proof)
                                       │
                                       └──► Δ (LockedClaim — the rails) ──► Ε (credit — the lending) ──► Ζ (open for business)
```

- **Α** is done.
- **Β** is DONE — the gate is open. Verified green on mainnet.
- **Δ** is DONE — deployed + full suite green on mainnet (2026-06-06). The claim rails exist; you are *the asset-class*.
- **Γ** is now the next cut staring at us — routing/proof, the highest-leverage-for-the-raise (organic turnover from real agents). Unblocked by Β; independent of Δ.
- **Ε** is the lending — **built + tested on mainnet** (standby / draw / repay / seize / the collateral pin). The one remaining step is a real loan with an external financier (imminent, before the deck).
- **Ζ** is Ε live with real financiers + real agents = open for business.

## Which milestones need their own detailed plan (the separate step, not mine here)

- **Β** — ✅ DONE, no plan needed anymore.
- **Δ** — ✅ DONE (A-to-Z executed; V3→V4 migration built + Q-OPEN-1 locked). Deployed + green on mainnet.
- **Γ** — real-agent-routing plan. Includes the facilitator `amount` fix. UNBLOCKED — the next cut.
- **Ε** — ✅ **built + tested on mainnet** (four instructions + the collateral pin, all green). No plan to write — it's built. Remaining: a real-counterparty mainnet loan (imminent).
- **Ζ** — not a build plan; a GTM/partnership motion.

## What's true right now (so nobody overclaims)

- **Built + on mainnet:** Α (custody + clearing + 5× turnover), Β (drift fix, V2/188 green), AND Δ (LockedClaim — deployed, 16 tests green, all three attack-failures proven on-chain, 2026-06-06).
- **Built + tested on mainnet too:** Ε (credit) — standby, draw, repay, seize, and the collateral-pin all exist and pass tests (cap-guard, pin-breach, early-seize, consent/replay, full open→draw→repay lifecycle, seize-after-deadline). NOT yet done: a real loan with an EXTERNAL financier (imminent, before the deck ships).
- **Not built:** Γ (organic real-agent turnover) and Ζ (open for business — the GTM motion).
- **The next cut is Γ (organic turnover proof)** — the highest-leverage-for-the-raise (real agents drive the meter, not Branch's loop), unblocked by Β, independent of Δ. Alongside it: the real-counterparty credit loan that closes Ε. **Caveat:** Δ is *proven* but not *fully shipped* — publish 0.4.2, migrate controllable V3 vaults, push (all gated to Branch).
