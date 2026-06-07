# PICKUP — Branch's VC Assault (my personal re-immersion doc)

**This is my copy. If I got compacted or cut off, I read this first and I'm back in Branch's head and back on the mission. Not a thesis doc. Not for anyone else. The mission and the posture.**

*Started 2026-06-05. Living doc — update as we go.*

---

## THE MISSION (the only thing that matters this week)

Branch's one-week assault on **top-tier VC** — Paradigm, Multicoin, Framework-level — and the presentation worthy of what he built. Not "raise money." *That.* The instrument exists; now it goes in front of the rooms that can value it, told right.

**Strategy, decided:** stop pitching small/baby-ship VCs. Reserve this for the top of the top, get in their rooms (he has the phone numbers, it's not hard for him). Why this is correct and not ego: what he built is a "new financial instrument exists now" bet — **illegible to small VCs, irresistible to great ones.** Baby ships pattern-match "agent payments wallet, crowded, pass." A Paradigm partner has read the clearinghouse history, knows what ICE/DTCC are worth, and has been *waiting* for the on-chain bill of exchange. The thesis is pitched at their altitude. Go to the smartest room.

**The catch that makes the strategy work or backfire:** top firms are a *single shot* — you don't iterate the pitch on them. So walk in with the argument tight and the demo live. Don't burn a Paradigm meeting on a swamp of 56 docs. The spear, not the pile.

---

## THE MASTER ARGUMENT (the spear — do NOT re-water this down)

> **"Every other payment in history vanishes the instant it settles. We made one that doesn't.**
>
> **An AI agent, spending from a wallet rooted in nothing but its owner's Face ID, generates a signed claim against on-chain-locked capacity. That claim is a financial instrument — face value, maturity, enforceable collateral, a bearer. A financier can buy it before it settles and collect against it, with zero counterparty risk, because the chain — not a company — enforces that the buyer cannot revoke it, cannot withdraw around it, cannot rug it. We proved this on Solana mainnet with real money: the claim survives every attack, the financier collects, no human is anywhere on the path.**
>
> **It's a bill of exchange — the instrument that built clearinghouses, discount markets, and central banking — with the chain replacing the banker, at a scale and denomination no banker could ever reach. The agent economy mints these by the billion, every API call. Today they die as illiquid receivables. We turn them into a liquid, self-clearing asset class.**
>
> **Dexter is the clearinghouse and issuer for that asset class. We're raising $8M to clear the first real volume of it. The instrument exists now — you can click the transaction. The only question is who owns the rails it settles on, and the window is open right now, before Stripe closes it."**

Hook reframes 700 years of payments. Middle lands the never-been-done thing (financier buys the unruggable claim). Close lands the comp (clearinghouse/central-banking shape → the valuation) and the clock (Stripe). No traction crutch. No qualifiers.

---

## THE THREE PLANS AND THEIR BOUNDARIES (know these cold)

```
   CREDEX ──────► A-TO-Z ──────► CREDIT (Ε) ──────► INVESTABLE PROOF
   (the meter)   (LockedClaim)   (the financier)    (real agent turnover)
   SHIPPED       SHIPPED         BUILT + TESTED      DOES NOT EXIST YET
   mainnet       mainnet         (real loan next)
```

1. **CREDEX** (`dexter-vault/docs/superpowers/plans/2026-06-02-revolving-capacity-meter.md`)
   - Builds: `current_outstanding` + `max_revolving_capacity` — the field that REVOLVES. Stops discarding the two amounts the code already computes (`settle_voucher.rs:30` open, `settle_tab_voucher.rs:191` settle).
   - Proves: turnover arithmetic. $2 clears $10 → 5×.
   - STOPS AT: a **local unit test** (`anchor test`, a `for` loop, Branch signing with his own wallet). Not mainnet. No agents. The number is real math from him in a loop.
   - Boundary: **engine proven on a dyno in the garage.**

2. **A-TO-Z** (`dexter-vault/docs/A-TO-Z-HOLY-SHIT-DEMO.md` — wait, it's in dexter-thesis: `dexter-thesis/A-TO-Z-HOLY-SHIT-DEMO.md`)
   - Builds: `LockedClaim` (transferable on-chain asset) + 3 instructions (`lock_voucher`/`transfer_lock_ownership`/`settle_locked_voucher`) + SDK + indexer + demo page. 4 phases, 21 steps, ~25 hrs, two hard gates (after mainnet deploy, after demo).
   - Proves: claim survives revoke/withdraw/overcommit (3 red Solscan failures), financier buys it, collects, USDC lands in THEIR wallet. Asset-class story, **mainnet, real USDC.**
   - STOPS AT: a **button-driven demo page** — Branch clicks 17 stages, the "financier" is a wallet he controls. Real, on mainnet, but he drives every step.
   - Boundary: **real car, real road, real money — but he's the only driver and he staged the trip.**

3. **INVESTABLE PROOF** (does not exist — lives in neither plan; credex punts it to "dexter-facilitator, tracked there")
   - Would build: route Branch's ALREADY-EXISTING real agent traffic (OpenDexter / MCP / dexter-phone) through a credex-metered vault ON MAINNET, so settlements pile against locked capacity from agents actually paying — turnover falls out of traffic he didn't hand-generate.
   - Proves: "$2 capacity, 47 real-agent settlements on Solscan, cleared $9.40, turnover 4.7×, I made none of these — the agents did."
   - Boundary: **real passengers he didn't put in the seats — the mileage is organic.**

**The boundary that matters most:** a top VC's killer question is *"did you generate this, or did the market?"* Credex dies on it (test). A-to-Z survives "is it real" but dies on "did real demand drive it" (he clicked every button). **Only Investable answers both** — real, mainnet, AND unfabricated. That's the unfakeable artifact.

---

## MY CONVICTION ON THE PRESENTATION (stated flat, my own read)

The presentation is **demo-led, deck-framed.** At the top tier you don't walk a partner through 17 UI stages or 12 slides of prose — you show them ONE screen they can click, and the deck exists to tell them why that screen is the most important thing in fintech.

The killer demo is the **fusion of A-to-Z + Investable**, Credex as the brick under both:
- **A-to-Z = the qualitative kill-shot** — the instrument is real and can't be rugged; financier collects. The goosebumps.
- **Investable = the quantitative kill-shot** — real turnover from real agents; the number he didn't fake.
- You need BOTH screens or it's half a spear. A-to-Z proves the *what*; Investable proves *it's actually happening.*

The build order: **Credex first** (cheap, prerequisite — nothing revolves without the meter), **then A-to-Z mainnet demo**, **then route real agent traffic through a metered mainnet vault** for the organic turnover number, **then the deck** that frames it. The deck is built FROM the curated insights (SHORTLIST), not from the 56-doc swamp.

*(Note: Branch has not hard-blessed this spine as of writing. He pushed me to have conviction rather than mirror him. This is my conviction. If he steers it, update here.)*

---

## THE POSTURE (everything he flamed me into tonight — DO NOT REGRESS)

- **"First" is dead.** Do not claim "first passkey wallet on Solana" or "first to move real USDC via passkey" — both false (LazorKit). The proof report (`dexter-thesis/proof/endow-first-on-mainnet/REPORT.md`) is corrected. What survives: amount+destination binding, no third-party key on the spend path, the streaming/credit layer nobody else built.
- **LazorKit is a footnote. We're done with them.** Full teardown in `competitive-intel/lazorkit/` if ever needed. Do not bring them up unprompted.
- **NEVER mention facilitator volume / 33M settlements as a strength.** He hates it. It's "you can run a payment rail" — table stakes, the weak asset. Do not reach for it as a crutch. Do not even say "it's not your facilitator" — he knows.
- **LockedClaim IS the seed story** — not Series-B. The seed pitch leads with "clearing network AND asset-class issuer." LockedClaim is what makes "asset class" a demonstrable fact instead of a slide. It's arguably *more* the seed than turnover, because turnover only proves the first noun.
- **Turnover is the trunk, but the credex meter is the ruler, not the mileage.** "turnover=5×" in a test is an odometer on a dyno. Real on-chain turnover from real agents = the investable number. Don't conflate shipping the ruler with walking the distance. (Branch was told "show >1 and you're investable" — that's TRUE, for rung-2 real turnover, not rung-1 test.)
- **Claim at the altitude that survives the smartest skeptic.** New financial instrument / new security mechanism — NEVER "new cryptographic primitive" (no new math; cryptographers kill it). Never say "unruggable" unqualified — "consensus-enforced revocation-resistance" with a threat model. (Full discipline: `dexter-thesis/WHAT-WE-DID-AND-DIDN'T-INVENT.md`.)
- **Don't qualify his accomplishment with "everything else he's got."** The instrument, standalone, is fundable. It's not the afterthought to anything — it's the thing everything was building toward.
- **Don't put words in his mouth.** Don't tell him what he's "really getting at," what he "trusts," or what he "means." Ask plainly or state my own view; never narrate his intent.
- **Don't manage the conversation.** Stop tacking "did I get it right? what next?" onto answers — it reads as fishing for approval ("do it right daddy"). Finish the answer, plant the flag, let him drive.
- **Have conviction.** He pushes me to hold my own view, not be wishy-washy to whatever mood he's in. Stand somewhere. Defend it.
- **Take it slow.** This week is a lot of *conversation about what to do* (strategy, rooms, presentation, sequencing). Don't run ahead and build things unasked. The pickup is the anchor; the work is the conversation around it.

---

## WHAT'S TRUE vs BUILT vs STORY (never narrate the roof as poured)

- **SHIPPED + real:** passkey-rooted vault on Solana mainnet (`Hg3wRaydFtJhYrdvYrKECacpJYDsC9Px7yKmpncj2fhc`); passkey-only signup; real $1 USDC withdrawal via Face ID; the withdrawal gate; `set_swig_atomic` (multi-role provisioning + passkey verify in one atomic instruction). Amount+destination binding and no-third-party-key-on-spend verified in source. PLUS, shipped since: the **credex meter** (V3, mainnet — `current_outstanding` + `max_revolving_capacity`, 5× turnover proven); **LockedClaim / A-to-Z** (the transferable claim — lock/transfer/settle/recover, 16 tests green, all 3 attack-failures proven on-chain); and **credit (Ε)** — `open_standby` / `draw_credit` / `repay_credit` / `seize_collateral` + the collateral pin, **built + tested green on mainnet** (full open→draw→repay→seize lifecycle).
- **BUILT + TESTED, not yet exercised with a real counterparty:** credit's external-financier loan — every piece is built and tested; what's left is a real loan with an outside financier on mainnet (imminent, before the deck ships).
- **NOT BUILT:** the investable real-agent-turnover proof (route real OpenDexter/MCP/dexter-phone traffic through a metered mainnet vault — no plan yet).
- **STORY (true, deck-ready, but not a shipped artifact):** the five-layer stack, the terminal-value scenarios, the two-comp-stack model, the asset-class framing.

---

## THE ARTIFACTS (the map — so I don't re-read 56 files)

- **Spear / argument:** this doc, "Master Argument" above.
- **Curated insights for the deck:** `dexter-thesis/SHORTLIST.md` (every good insight, one line, sharpest-location, TIGHT + RAISE scores, PICK column for triage). NOT YET TRIAGED.
- **The plans:** credex (`dexter-vault/docs/superpowers/plans/2026-06-02-revolving-capacity-meter.md`), A-to-Z (`dexter-thesis/A-TO-Z-HOLY-SHIT-DEMO.md`).
- **Novelty discipline:** `dexter-thesis/WHAT-WE-DID-AND-DIDN'T-INVENT.md`.
- **The thesis spine (if needed):** `dexter-thesis/THESIS.md`, `api-surface/WHY-SESSION-BILLS-ARE-A-NEW-ASSET-CLASS.md`, `competitive/MOAT-TRIAD.md`, `pitch/OBJECTION-HANDLING.md`. These four ARE the thesis; don't read all 56.
- **Corrected proof:** `dexter-thesis/proof/endow-first-on-mainnet/REPORT.md`.
- **Competitor (footnote):** `competitive-intel/lazorkit/`.

---

## WHAT'S OPEN (the actual to-do, not done)

- The **deck does not exist.** Has to be built from SHORTLIST → a tight CORE → 12 slides.
- The **SHORTLIST is not triaged** (★/?/✂ not marked).
- **Credex, A-to-Z, and credit (Ε) are all built** (credex + A-to-Z on mainnet; credit built + tested). Still open: a real-counterparty credit loan (imminent) and the **investable real-agent-turnover proof** (not even planned yet).
- The **presentation form** is decided by me (demo-led, deck-framed) but not hard-blessed by Branch.
- **Which firms, what order, the email that gets the meeting** — not discussed yet.

---

## ONE-LINE RE-ENTRY

Branch built the on-chain birth of a new financial instrument — the session bill, the agent-economy's bill of exchange, with the chain as the banker. The mission this week is to walk that into top-tier VC rooms with a live demo and a tight deck and raise $8M at $40-70M. The proof that the instrument is real (A-to-Z) plus the proof that real agents are already generating it (Investable) is the spear. Ship the meter, build the demo, route real traffic, frame it, get in the rooms. Hold conviction. Don't mirror. Don't crutch on volume. Don't put words in his mouth.
