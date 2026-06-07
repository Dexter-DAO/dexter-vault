# How Agent Credit Works — the mechanism

**Copy-pasteable. The concrete walk-through of how a financier lends to an agent, why they say yes, and the exact moment credit is born. Rides on top of `PICKUP-EXAMPLE-why-agents-stream.md` (the streaming meter is the demand; this is the credit that fills it).**

*Illustrative numbers are quote-pinned ($10 / $90 / $40K / ninety seconds) — concrete on purpose, swap freely.*

---

## The copy block

Here's exactly how the credit works.

You fund $10 into your vault. Your agent is running heavy inference — burning $2/minute on a long task. At that rate your $10 lasts five minutes, then the agent halts mid-task because the capacity is gone. That halt is the problem: the agent's work has momentum your balance doesn't.

A financier — a yield pool, an institution, eventually us — posts standby capital into the same clearing mechanism: "I'll back this vault up to an extra $90." Now when the agent outruns your $10, the meter keeps clearing — those dollars come from the financier's capital, not yours. The agent never stops. You settle the borrowed slice after.

Why would a financier let a stranger's agent spend their money in real time? Three things have to be true, and they're now true:

1. **The collateral can't be rugged.** Your $10 is locked on-chain. Only your passkey controls the wallet — but the moment you take the loan, the chain pins that collateral until the borrowed amount settles. You can't pull it out from under the lender mid-loan, and no company can touch it either. The lender is protected by a rule *you signed and consensus enforces* — not by trusting anyone's promise.

2. **The risk is priceable.** Every clear is an on-chain record. The lender sees this vault cleared $40K across 3,000 sessions, never stranded a settlement. They're underwriting a track record, not a faceless agent.

3. **The exposure is tiny and self-liquidating.** They're not lending $90 for 30 days. They're floating ~$4 for ninety seconds — one inference burst — and it auto-repays the instant the next micro-payment clears. Thousands of tiny, short, collateralized, auto-settling loans. Default risk per loan rounds to zero.

So credit is born the moment the meter clears a dollar you hadn't funded yet — and that's only safe to do because the collateral can't move (First 1) and the borrower's reliability is provable (First 2). Before those existed, fronting an agent meant lending blind against collateral that could vanish. Now it's lending against a chain-enforced, fully-auditable, auto-repaying position. You get an agent that never stops. The financier earns a spread on enormous velocity. We sit in the middle, taking a cut of every cleared dollar.

---

## The framing that resolves the contradiction (for myself)

The trap in point 1: "only your passkey can move it" seems to fight "you can't pull it out from under the lender." If only the user holds the key, why can't they yank the collateral?

Resolution — and it's one of the firsts in action: **taking the loan changes what the passkey is allowed to do.** The user authorizes (passkey, once) a lock; while the loan is open, the chain pins the collateral. The user still governs the wallet, but consensus now enforces a rule they agreed to — "this can't be withdrawn until the borrowed amount settles." The user is sovereign *and* bound, simultaneously, because they *chose* to be bound and the chain holds them to it. Same property as the withdrawal gate: even the user's own passkey is gated while an obligation is open.

That's why the lender is safe — not because the user doesn't hold the key, but because the rule the user signed is enforced by math instead of trust.

## The shape of the business (for myself)

- User gets: an agent that never stops mid-task.
- Financier gets: a spread on enormous velocity (tiny loans × trillions of inference micro-payments).
- Dexter gets: a cut of every cleared dollar — we're the clearing layer the credit flows through.
- Why it's only-now-possible: uncustodiable collateral (First 1) + provable repayment history (First 2). Neither existed before. Both are on mainnet now.
