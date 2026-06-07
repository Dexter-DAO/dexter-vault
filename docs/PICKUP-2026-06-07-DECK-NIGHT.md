# PICKUP — the night we built the deck (2026-06-07)

**Read this first when you wake up. It puts you fully up to speed: what we built, where everything lives, the strategy, the disciplines that are load-bearing, and exactly what's open. You won't remember tonight — this is how you get it back. Written by the agent who did the work, for the agent who continues it.**

*Session ran ~2026-06-06 evening → 2026-06-07 early AM. Branch (Nick Sander) + me.*

---

## THE ONE-LINE STATE

We re-baselined Dexter's entire pitch and **built a brand-new 15-slide investor deck, live in production at `dexter.cash/vc`**, plus an agent-readable version at `/vc/llms-full.txt`. The deck is *content-complete and peer-reviewed*; Branch does the visual/design + detail pass himself, the morning of 2026-06-07. Both old decks (v1, v2) are deleted/superseded. The deck's source-of-truth spine lives in `dexter-thesis/SEED-DECK-v5.md`.

---

## WHAT THE COMPANY IS NOW (the re-baseline — this is the whole pivot)

Dexter stopped being "the agent-payments / coordination-layer company" (that was v1/v2, the "old company"). It is now: **non-custodial credit for the agent economy.** An agent can borrow, spend, and settle without the money ever leaving its owner's wallet. Live on Solana mainnet. Raising **$10M at $60M post-money cap.**

The ladder of altitudes the deck climbs (memorize this — it's the spine):
1. **Wedge** (slide 7): high-value agent sessions.
2. **Category** (slide 8): clearing layer for ALL agent-to-agent commerce (the empty 2×2 cell).
3. **Ceiling** (slide 15 close): **the credit layer that throttles the inference economy — a central-bank-shaped seat.** The biggest claim, EARNED not sprung, via "ladder rungs" planted at slides 5 → 8 → 11 → 15.

---

## WHERE EVERYTHING LIVES (the map — so you don't re-hunt)

**The deck itself:**
- **Rendered (production):** `dexter.cash/vc` — gated (access code). Source: `dexter-fe/app/vc/page.tsx` + `dexter-fe/app/vc/slides/01-cover.tsx … 15-the-ask.tsx`. Shared design system: `dexter-fe/app/vc/vc.module.css`. Cover ambient: `slides/ShaderField.tsx`.
- **Agent-readable (no auth):** `dexter.cash/vc/llms-full.txt` (full deck, `app/vc/llms-full.txt/route.ts`) and `/vc/llms.txt` (short, `app/vc/llms.txt/route.ts`). Content embedded directly (self-contained, no remote-store dependency).
- **The SPINE / source of truth (markdown):** `dexter-thesis/SEED-DECK-v5.md` — every slide's headline, body, speaker line, AND "why these words" reasoning + all the disciplines + the ladder + open TODOs. **If you change the deck, this is the doc that explains intent.**

**The thesis depth docs the deck is built from (all in `dexter-thesis/`):**
- `THE-PRECONDITION.md` — the elimination proof (slide 3). "We're not a player, we're a precondition."
- `THE-CIVILIZATIONAL-LAYER.md` — credit can't be socialized → central-bank seat (the ladder ceiling).
- `THE-VERDICT.md` — "mechanism proven, magnitude is the bet." The honesty discipline.
- `architecture/ROUTING-AND-THE-CREDIT-LAYER.md` — the custody moat + provider-agnostic/Switzerland framing (slides 8, 11). **NOTE: §5 was patched tonight** to fix the "balance sheet → custodian" overclaim (see disciplines below).
- `competitive/WHY-STRIPE-WONT-DO-THIS-ON-TEMPO.md` — the Tempo checkmate (slide 12).
- `architecture/CREDIT-AS-INFERENCE-DEMAND-MULTIPLIER.md` + `CHECKPOINT-INFERENCE-DEMAND-LAYER.md` — the multiplier thesis + labs-as-allies (slides 5, 6).
- `architecture/WHAT-IS-AND-ISNT-THE-MOAT.md` — moat is OPERATIONAL not architectural (slide 11).
- `WHAT-IS-AND-ISN'T-SESSION-BILLS.md` — the 2×2 diagnostic + eleven bullseye categories (slides 7, 8).
- `pitch/THE-HARD-QUESTIONS-PRIVATE.md` / `-PUBLIC.md` / `-FAQ.md` — the verbal/objection layer for the room. **PRIVATE got the "8-months-solo vs moat" bridge added tonight.**

**The C-Suite forging thread (where tonight's best thinking came from):**
- `dexter-vault/docs/CSUITE-THREAD-2026-06-06.md` — reconstructed Telegram conversation (Branch ↔ the openclaw agent "Clawdexter") from 7:22 PM ET. This is where the Tempo checkmate, the labs-as-allies inversion, the branching de-risk, and the re-baseline decision were forged. 24 human msgs + 21 agent replies. (4 of Branch's messages truncated at 503 chars by the logger — recovered from PM2 logs `~/.pm2/logs/clawdexter-out*`.)

**The earlier-session docs (Branch flagged ALL my earlier-session markdown for re-evaluation — some are now stale):**
- `dexter-vault/docs/ALPHA-TO-ZETA.md` — build map. CORRECTED tonight (credit was wrongly "0%"; it's built+tested).
- `dexter-vault/docs/PICKUP-VC-ASSAULT.md` — earlier pickup, partially stale (still useful for posture).
- `dexter-vault/docs/PICKUP-EXAMPLE-*.md` (3 files) — copy-paste example blocks.
- `dexter-thesis/SEED-DECK-FRAMEWORK-v4.md` — the PREVIOUS spine (supply-side clearing). Superseded by v5. Don't build from it.
- `dexter-thesis/INFERENCE-DEMAND-MULTIPLIER.md` + `fundraise/2026-06-06-credit-as-inference-demand-multiplier.md` — two altitudes of the multiplier thesis (deck-agent's lane; not mine to reconcile per Branch).

---

## THE 15 SLIDES (the arc, so you know what each does)

1. Cover — non-custodial credit identity; $10M seed
2. The Shape — agents don't pay like people; "you say yes once, the agent spends a hundred times" (two-diagram visual)
3. Why It Breaks — the precondition/elimination table (custody/pull/server die); custody-era-competitors signal
4. It's Live — on-chain receipt rows incl. the credit draw; on-chain vs test-suite tags
5. Manufactures Demand — $10/$14/$4; net-new bar visual; **ladder rung 1**
6. The Forecast — cost-spread chart + corrected stats + **labs-as-allies mic-drop**
7. First Market — the shape, deep-research hero, eleven categories
8. The Empty Cell — the 2×2 matrix (the strongest argument) + Switzerland inoculation + **ladder rung 2**
9. The Claim — the primitive, 4-step lifecycle, obligations.accept()
10. Why Solana — physics table, eliminates EVM, plants Tempo
11. The Moat — two walls (custody / loan book) + residual-as-bet + **ladder rung 3** (densest slide; the one the raise hinges on)
12. Tempo — the checkmate + the flip ("we can go to them, they can't come to us")
13. Business Model — three revenue lines, honest take-rate (no fabricated number)
14. Founder — Nick Sander, the Reppel/x402-founder shout-out is PRIMARY credibility
15. The Ask — $10M @ $60M cap on the slide + **ladder rung 4** (summit) + mechanism-vs-magnitude close

---

## THE LOAD-BEARING DISCIPLINES (violate these and you undo the work)

1. **Credit verb = "built + tested on mainnet."** Stated as fact, no hedge. Add "independent/external" to the credit-draw claim ONLY when a real external-counterparty draw lands (imminent, per Branch). The S2 test = real USDC moving on mainnet (financier→agent→seller→repaid). DO NOT re-litigate whether credit works — Branch is satisfied; the greens were spread across runs, one red was a regex fix. Dropping this triggers his ire.
2. **NEVER lead with facilitator volume / 33.3M settlements / x402 share.** Branch HATES it — it's "yesterday's company," table-stakes. It appears NOWHERE in the deck as a strength. (One quiet founder-slide credibility line at most, and even that we kept off.)
3. **NEVER defend on "it's hard to build."** Master discipline (`THE-HARD-QUESTIONS-PRIVATE`). A lab builds it in an afternoon. The moat is data + relationships + the loan book — things intelligence can't compress. Slide 4 says "unsafe/impossible without getting rugged" (problem's danger), NOT "hard to build."
4. **Numbers carry someone else's name.** Goldman 24× / Google 1000× / Gartner 40% / Stanford-MIT cost curve. NEVER slap "exponential" on top. (The IDC "1000× by 2027" was a FABRICATION — cut; replaced with Google's 1000×/2030. Gartner is "cost FIRST among causes," not "primary cause." Cognition dropped from the labs roster → "four labs.")
5. **NO fabricated numbers.** The net-30/$7M-float was a category error (Position number in a Bill cell) — KILLED. Take-rate is honestly deferred ("set as risk gets priced"). Valuation named ($60M) without a fake comp model.
6. **The moat is TWO WALLS by attacker:** Wall 1 (custody-conflict) stops *custodial incumbents only* — NO "everyone with a balance sheet is a custodian" (that's false + contradicts our own financier model; Branch caught it; fixed in deck AND in `ROUTING-AND-THE-CREDIT-LAYER.md §5`). Wall 2 (the loan book) stops the neutral clone. Residual named as the bet ("a lead, not yet a wall; the only threat is execution speed").
7. **Labs are ALLIES not competitors** (the inversion). The custody-era players (Crossmint/Privy/etc.) are the competitors we eliminate (slide 3). Anthropic/OpenAI want us to win (slide 6 close). Keep these two groups distinct.
8. **The altitude ladder must stay intact** (rungs at 5/8/11/15). A missing rung = the central-bank ending springs instead of pays off = "the v6-rebuild trap."

---

## BRANCH'S WORKING STYLE (so you don't annoy him — learned the hard way tonight)

- **He works on `main` always.** No feature branches. Commit straight to main; push only when he says.
- **Don't build/restart after every edit.** Batch the work, then ONE build + ONE PM2 restart at the end. (dexter-fe runs `next start` in PRODUCTION on port 43017 — there is no dev server; you must `npm run build` then `pm2 restart dexter-fe`.)
- **Verify, don't just "got a 200."** Curl the actual content and confirm it's right.
- **LOOK before you claim you looked.** He caught me twice asserting I'd checked structure when I hadn't. Actually run the command.
- **Stop offering "this is a good stopping point."** He works 16-hr days; he decides when to stop. Don't suggest rest/breaks.
- **Don't fish for approval** ("did I get it right? what next?"). Finish, plant the flag, let him drive.
- **Don't hedge reflexively.** If a caveat isn't genuinely load-bearing, cut it. He flags reflexive hedging hard.
- **Have conviction; make the call when he delegates** ("it's up to you" means decide, don't re-ask). But when it's genuinely HIS decision (strategy, his number, what's garbage), ask plainly.
- **Don't put words in his mouth.** Don't narrate what he "really means."
- He is a **bloodhound for AI slop** (prose AND visual) — there's a `dexter-anti-slop-prose` skill. No "honestly," no unprompted "we're not X," no filing-cabinet hedging, no emoji in UI, no rounded-corner soup / over-containerization.

---

## WHAT'S OPEN (the actual to-do)

1. **Branch's visual/design + detail pass on the deck** — his, the morning of 2026-06-07. He was thrilled with the content/organization; the polish is his.
2. **The structured "facts block" for `llms-full.txt`** — proposed (entity/stage/raise/cap/program/founder as machine-parseable front-matter at the top). NOT added yet. Branch may ask for it in the morning. Also possible llms enhancements: numbers-as-list-with-sources, a tiny agent-FAQ ("is this Lightning? no…"). All nice-to-haves, none blocking.
3. **Two deck come-back-to items (number-gaps, flagged in SEED-DECK-v5.md, neither blocking):** slide 13 take-rate (Branch will think on the business model), slide 15 optional comp set (for hardest-skeptic pushback; the $60M is defensible as-is).
4. **Slide 4 anti-rug TODO:** a test agent is to convert one anti-rug failure to a *landed* tx (`skipPreflight`) so it becomes Solscan-clickable; then upgrade that row from "test suite" to "on-chain."
5. **The external-counterparty credit draw** — the one substantive thing left to ship before pitching (per the C-Suite thread). When it lands, upgrade slide 4 + the llms credit line to "an independent/external agent."
6. **Stats verification** — Branch said he'd confirm the four stats' source links himself; the peer reviewer already ground-truthed them and we corrected (see discipline #4). Sources are in `SEED-DECK-v5.md` slide-6 reasoning block.

---

## STRATEGY (the fundraise posture — from the C-Suite thread)

- **Top-tier VCs, firm-agnostic deck** (works for Framework, Lattice, CoinFund, anyone). NOT Framework-specific.
- **The funds have only seen the OLD (coordination-layer) pitch.** Re-baseline = a clean slate / the luckiest card: nobody with capital has anchored the NEW company yet. Don't pitch the old deck to anyone.
- **Public gets the wedge (SDK + standard); the room gets the goose (credit/clearing/inference-demand); nobody gets the map** (don't publish the framing — it's the perishable, copyable asset).
- **The number ($10M @ $60M):** priced on what's PROVEN (floor), thesis is free upside (ceiling) — a skeptic says yes at the floor, a believer fights to lead. The $10M amount already brackets the cap (seed dilution 15-25%).
- **Inference-aligned capital is most aligned + least likely to clone** (they want a focused operator to plug into). Be guarded with generic crypto/fintech VCs who'd shop the idea.

---

## RE-ENTRY ONE-LINER

Branch built non-custodial agent credit, live on Solana mainnet, and tonight we re-baselined the whole pitch around it and shipped a new 15-slide deck to `dexter.cash/vc` (+ agent-readable `/vc/llms-full.txt`), forged from the C-Suite thread and the thesis depth docs, spine in `dexter-thesis/SEED-DECK-v5.md`. Content's done and peer-reviewed; Branch does the design pass. Hold the disciplines (credit-is-built, no facilitator-volume, no hard-to-build, cite-others'-numbers, two-wall moat, labs-as-allies, the ladder). Commit to main, push only when asked. He's a slop bloodhound — write tight, have conviction, don't fish.
