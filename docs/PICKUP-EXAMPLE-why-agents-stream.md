# Why Agents Stream — the arc

**Copy-pasteable. The narrative from "the two firsts" → "why agents pay differently" → "why no existing rail can do it" → "why only we cracked it." Sets up the credit story (see `PICKUP-EXAMPLE-how-agent-credit-works.md`), which rides on top of this.**

*Illustrative numbers are quote-pinned — swap freely.*

---

## The two firsts (the foundation everything else rides on)

**First 1 — Sole-passkey custody, proven with real money.** The first wallet on Solana mainnet where *only* the user's passkey can move funds out — no session key, no admin bot, no facilitator, no company key anywhere on the spend path — demonstrated by a real USDC withdrawal authorized by nothing but Face ID, the chain itself enforcing "only this passkey, this amount, this destination."

**First 2 — Non-custodial revolving capacity, proven on-chain.** The first time the same locked capacity has been shown to revolve at turnover > 1 (5×) on mainnet, non-custodially — capacity that clears many times its face value while the user keeps custody — the on-chain birth of the clearing primitive.

One is **custody** (only your passkey moves money). The other is **clearing** (one locked dollar clears many). Nobody found has either. We have both.

---

## Why agents — the copy block

Credit needs collateral a lender can trust and a borrower history they can price.

For agents, neither existed — until now.

First 1 gives the uncustodiable collateral, First 2 gives the on-chain repayment record. With both, a financier can finally lend to an agent. This is the part we build next.

**Why agents?** Because an agent doesn't pay like a person. A person makes one purchase, one price, one click. Agent payments run a *meter* — agents stream thousands of tiny payments for inference, tokens, tool calls, compute, second by second, with no human approving each one. That's a flow no card, no invoice, no checkout was ever built for: too small, too fast, too constant, and nobody at the keyboard.

And it's consumed *as it's delivered*. Even when the AI's chat message is half-done, you've already spent $5 of $10 — and there's still $5 more coming in the remaining minute it takes the model to finish responding. That right there, times a trillion for the inference economy, is where the demand for credit is born. We become the payment mechanism the inference providers charge through, and we connect to the entire world of agents doing inference.

That streaming meter is exactly what we built — capacity that opens once, then clears continuously, bounded by rules the blockchain enforces instead of a human clicking "approve."

After all our work in x402, I'm certain this is the native shape of how machines spend. Not a secret, but not well understood yet. Some — Stripe and VCs especially — are waking up to the fact that the entire agent economy will run on streaming session payments.

But the rest of the world came at it from the escrow perspective. Escrow means the money can't be *cryptographically proven* to have reserved capacity — it's a promise held by an operator, the way the whole world has always worked. We're the only ones who figured out how to do it on-chain, where the reserved capacity is a proof, not a promise — unlocking it universally, at sub-second finality and low cost.

---

## The logic chain (for myself — why it holds)

agents pay differently (a meter, not a click) → existing rails can't do it (too small/fast/constant/unattended) → we built the meter → it's the native form of machine payment → the whole inference economy runs on it → and we're the only ones who did it on-chain (provable reserved capacity vs. escrow's promise).

The mic-drop is the last line: **escrow = a promise; on-chain reservation = a proof.** That's the moat sentence — keep it last, keep it sharp.

The one seam to be aware of: the half-done-message proves *streaming* (metering, pay-as-you-go). The *credit* is born one step later — when the meter runs faster than the wallet is funded and a financier floats the gap. "Where the demand for credit is born" is the honest phrasing; the mechanism is in the credit doc.
