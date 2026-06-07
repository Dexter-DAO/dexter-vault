---
title: "OTS Proof-of-Control: the missing identity primitive"
subtitle: "prove_passkey, non-custodial SIWX, and what passkey-wallets unlock"
date: 2026-05-29
status: Working notes (not yet a spec edit)
---

# OTS Proof-of-Control — working notes

These are notes captured 2026-05-29 while building `prove_passkey` and reading the
OTS standards proposal. The headline: **OTS today specifies non-custodial
*spending*, but not non-custodial *identity*.** We just built the identity half,
and it appears to be a genuinely missing piece of the standard rather than a
Dexter-only product feature.

---

## 1. The core insight: your wallet is a *program*, not a keypair

A raw keypair can only **sign**. An OTS vault (passkey + Swig + the vault program)
can **enforce rules, prove things, delegate scoped authority, and recover**. Every
"interesting use" below comes from that single fact. This is the actual product
insight — the wallet being programmable is the moat, not any one feature.

---

## 2. The missing primitive: proof-of-control

OTS §2.4 enumerates the required on-chain instructions — `initialize_vault`,
`set_swig`, `settle_voucher`, `request_withdrawal`, `finalize_withdrawal`,
`force_release`, rotations. **Every one is about authorizing or gating funds.**

There is no instruction in the standard for *"prove I control this vault without
spending."* Yet §2.2 (Wallet shape) requires property #1: *"Root authority is a
WebAuthn-verifiable key."* The standard never specifies **how a relying party
verifies that control off-chain for non-payment purposes** (login, gating,
reputation). The whole document is settlement; identity-proof is implied but
unspecified.

`prove_passkey` is exactly that complement. EIP-1271 exists on Ethereum precisely
because "prove a smart-wallet controls an address" is needed standalone, separate
from spending. **OTS has the spending half and is missing the identity half. We
just built the identity half.**

### How it works (proven)

A verifier proves passkey control of a vault **read-only, off-chain, with no funds
moved and no transaction signed**:

1. The passkey signs a challenge: `"siwx_login" || challenge_bytes` (WebAuthn).
2. Build two instructions: `[secp256r1_verify_ix, prove_passkey_ix]`.
3. `simulateTransaction(tx, { sigVerify: false })` — the passkey "signs" via the
   SIMD-0075 precompile *instruction data*, not a transaction signature.
4. `err === null` ⇒ the passkey controlling this vault signed this challenge.

`prove_passkey` reads the vault, verifies the passkey assertion over the challenge
via the existing `verify_passkey_signed` helper, and **mutates nothing** (the
`vault` account is read-only, no signer required). It is the Solana equivalent of
EIP-1271's `isValidSignature`.

**Status:** instruction written, compiles clean, in the IDL (read-only / no
signer). The simulate mechanism is **proven on mainnet** (the secp256r1 precompile
executes during `simulateTransaction`; valid sig → `err:null`, tampered sig →
`InstructionError`). The full flow is **proven on a local validator** (right
passkey passes; wrong passkey and wrong challenge both rejected; 25/25 tests pass,
zero regressions). Not yet deployed to mainnet — a ~2 SOL program upgrade.

---

## 3. Interesting uses this unlocks for passkey-wallet holders

Once "a passkey can prove control of its vault, read-only" exists, you have an
**identity layer** — and that unlocks far more than login. Specifically enabled by
your wallet type (passkey + Swig + vault program), not generic:

- **Gated access to anything, not just payments.** "Prove your vault to unlock X."
  Premium intel on x402gle, early features, a holders-only tier. `prove_passkey`
  already does this.
- **Portable reputation / history.** The vault has an on-chain address; let a holder
  prove "this is my agent's track record" across services without an account.
  Agent-native reputation.
- **Delegated, capped sub-authorities.** The Swig already has the 3-role model. Let
  holders mint *scoped* session keys for their *own* agents ("this key can spend
  $5/day on APIs, expires in 24h") — non-custodially, because the passkey authorizes
  the delegation on-chain. **Note: this is surfacing a capability the standard
  already has (OTS §3.4: tokenLimit + TTL + program allowlist), not a new build.**
- **Recovery-as-a-service.** `force_release` + key rotation already exist. "Lose your
  device? Your passkey vault survives" is a real differentiator vs. seed phrases.
- **Programmable spend rules.** The vault is a program; spend limits, allowlists, time
  locks are wallet-level features competitors with raw keypairs cannot offer.

The connecting thread: **a keypair can only sign; a vault can enforce, prove,
delegate, and recover.**

---

## 4. Where this should live

- **OTS (dexter-vault) — as an addition to the standard.** Add `prove_passkey` to the
  §2.4 instruction table (likely a new tier: "identity / proof-of-control"), plus a
  short section specifying the simulate-based verification pattern so *other*
  implementers can build the same off-chain "is this passkey the vault's owner"
  check. It upgrades the §7 adoption pitch from "non-custodial *spending*" to
  "non-custodial *identity AND spending*" — and answers the question every wallet
  implementer in §7.4 will ask: "how does my user prove ownership to a service?"
- **x402 — as the wire-format scheme.** §4.2 already states intent to propose a `tab`
  scheme to x402. The SIWX/login side rides alongside that: OTS *defines* the
  identity primitive, x402 is where the on-the-wire scheme gets *implemented* for
  third-party verifiers. Both homes, different roles — exactly as the doc already
  structures OWS vs OTS vs x402.

**Editorial caveat:** the OTS proposal currently states everything in it is live at
`Hg3wRaydFtJhYrdvYrKECacpJYDsC9Px7yKmpncj2fhc`. `prove_passkey` is **not deployed
yet**, so adding it to the doc now would describe something not-yet-on-chain.
Decision pending: edit the doc now, or keep it frozen until the instruction is live.

---

## 5. Naming correction (for the record)

"Solana-1271" is a **coined nickname**, not a real standard — there is no SIMD or
spec by that name. It was shorthand for "the Solana analogue of EIP-1271." The OTS
proposal already frames the real EVM equivalents correctly (§1.2, line 52):
*"ERC-4337 + a custom session-key validator, EIP-1271 smart-wallet verification, and
an EVM passkey precompile (RIP-7212)."*

### Real sources (verified reachable 2026-05-29)

| Doc | What it is | Created / age |
|---|---|---|
| [EIP-1271](https://eips.ethereum.org/EIPS/eip-1271) | Ethereum `isValidSignature` for smart contracts — the thing analogized | **2018** — old, proven, foundation of EVM smart-wallet sign-in |
| [EIP-6492](https://eips.ethereum.org/EIPS/eip-6492) | Pre-deployment extension of 1271 | 2023 |
| [SIMD-0075](https://github.com/solana-foundation/solana-improvement-documents/blob/main/proposals/0075-precompile-for-secp256r1-sigverify.md) | The Solana secp256r1 precompile the vault uses | **New** (last touched 2026-03) |
| [CAIP-122](https://github.com/ChainAgnostic/CAIPs/blob/main/CAIPs/caip-122.md) | "Sign in With X" message format | Active (updated 2025-07) |

**Takeaway on "is this new":** the *concept* is old and proven (Ethereum since 2018);
doing it on Solana via passkeys is genuinely fresh ground because the precompile
underneath (SIMD-0075) is recent. That is precisely why no "Solana 1271" exists yet
— the floor only just got poured. It is a legitimate upstream contribution, not
reinventing a wheel. If it becomes a named standard, **Branch names it** — it does
not exist until proposed.

---

## 6. The wallet-factory question (open, not yet resolved)

Branch's instinct: "I feel like I need a Swig wallet factory that adheres to the
system." Honest framing — there are two different problems hiding in that itch, with
different answers:

- **If the pain is *scattered* vault creation** (the two enroll paths in
  `passkeyVault.ts` vs `passkeyVaultAnon.ts` that could drift) → the "factory" is a
  *consolidation*: one canonical `createVault()` the whole system uses. A refactor,
  genuinely useful, low-risk.
- **If the pain is a *missing capability*** (programmatic / fleet vault creation, not
  a human-at-a-device) → that is a real new feature, and it hits a hard design
  question: a vault's root authority is a *passkey*, and you cannot programmatically
  conjure passkeys for a fleet of agents without a different model.

These have very different answers; don't build a `WalletFactory` abstraction on a
vague feeling. Next step is to read how vaults actually get created today and what
the Swig role model can express, then decide which of the two it is.
