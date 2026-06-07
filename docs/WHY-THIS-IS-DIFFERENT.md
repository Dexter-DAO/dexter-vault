---
title: "Why a Dexter wallet is different"
subtitle: "Your wallet is a program, not a keypair — and your key is unstealable hardware"
date: 2026-05-29
audience: Adopters, wallet implementers, partners, investors
status: Narrative / positioning (companion to the OTS standards proposal)
---

# Why a Dexter wallet is different

This is the positioning companion to the [OTS standards proposal](./OTS-STANDARDS-PROPOSAL.md)
and [technical brief](./OTS-TECHNICAL-BRIEF.md). Those documents prove the system is
*correct* (for auditors). This document explains why it is *different* (for everyone
else). Two ideas carry the whole thing:

1. **Your wallet is a program, not a keypair.**
2. **Your key is unstealable hardware — on a curve the blockchain can't natively speak.**

Everything Dexter can offer that a normal wallet cannot follows from these two facts.

---

## 1. A normal wallet is a keypair. It can only sign.

A standard Solana wallet *is* two numbers: a private key (secret) and a public key
(the address). That is the entire wallet. A keypair can do exactly one thing:
produce a signature. Hand it bytes, it signs them.

It has no logic, no memory, no opinion. It cannot say "no." It cannot check a
condition. It cannot remember what it signed yesterday. Whoever holds the private
key can sign **anything** — including draining the whole balance. The key does not
care.

A keypair is a **signature stamp.** It stamps. It cannot read the document, cannot
refuse, cannot recall. Steal the stamp and you stamp whatever you want.

This is true of every raw-keypair wallet, and it is *almost* true of custodial
wallets too — except there, someone else holds the stamp.

---

## 2. A Dexter wallet is a program. It enforces, proves, delegates, recovers.

A Dexter wallet is an on-chain program (the vault program, live at
`Hg3wRaydFtJhYrdvYrKECacpJYDsC9Px7yKmpncj2fhc`) plus an account holding state. When
"the wallet" acts, it is not "a key signs bytes" — it is **code runs and decides.**

Code can do what a stamp fundamentally cannot:

- **It can say NO.** `finalize_withdrawal` checks "are any tabs open? then reject" —
  on-chain, not as a matter of policy. A keypair could never refuse its own owner.
  The vault does, by design; that refusal *is* the seller-protection guarantee.
- **It can remember.** The vault account stores the bound passkey, the swig address,
  the outstanding-tabs counter, a pending withdrawal. State persists across
  transactions. A keypair remembers nothing.
- **It can require combinations.** "A passkey signature AND zero open tabs AND the
  cooling-off elapsed." A keypair only knows "valid signature: yes/no."
- **It can delegate with limits.** The bound Swig smart-wallet grants a session role
  capped at a spend limit, a TTL, and a program allowlist. A raw keypair cannot hand
  out a *limited* version of itself — you either have the key or you don't.
- **It can prove control without spending.** The program can answer "yes, this
  passkey controls this vault" as a read-only fact, separate from moving money. (See
  §5, proof-of-control.)
- **It can recover.** `rotate_passkey` (move to a new device), `force_release` (escape
  an abandoned tab). Lose a raw keypair and the funds are gone forever; the vault has
  coded escape hatches.

A Dexter wallet is **a safe with a programmable lock and a rulebook** — not a stamp.
The rulebook is public, on-chain code. The safe enforces its own rules, and there is
no master key that overrides the program, because **the program is the authority.**

This is also the real meaning of "non-custodial" here. For a keypair, non-custodial
means "you hold the secret." For a Dexter wallet it means something stronger: **the
rules are enforced by public on-chain code nobody — including Dexter — can override.**
The trust is not "trust Dexter not to touch your key." It is "read the program; it
*cannot* drain you." Trust the code, not us.

---

## 3. The key is unstealable hardware — and that is the hard part

The wallet's root authority is a **passkey** — a WebAuthn / FIDO2 credential. The
private key lives in the device's secure hardware (Secure Enclave, TPM, a hardware
security key), gated by your face or fingerprint, and **can never be extracted** —
not by you, not by malware, not by Dexter. That is a far stronger guarantee than an
ed25519 key sitting in a file or a browser.

But a passkey is **secp256r1 (P-256)** — a *different curve* from Solana's native
ed25519. This creates a real limitation:

- **Solana does not natively understand P-256.** A passkey signature is not a valid
  Solana transaction signature. The chain looks at it and does not know what it is.
- **A passkey cannot be a transaction's signer or fee payer.** Solana transactions
  must be signed by ed25519 keys. The passkey is not one.
- **A passkey signs a WebAuthn envelope, not raw bytes.** When you authorize with your
  face, the hardware signs `authenticatorData ‖ sha256(clientDataJSON)` — a structured
  blob with the real challenge buried inside as a base64url field — not the message
  you handed it.
- **There is no private key to "use."** The secret never leaves the hardware. You can
  only ask the hardware, face-gated, to sign — and get back the WebAuthn envelope.

So you have a beautiful, unstealable, hardware-locked key... that the blockchain
cannot directly accept. **That is the limitation.** A naive design would give up and
fall back to a software keypair (stealable) or a custodian (not yours).

---

## 4. The bridge: how an unstealable key becomes the boss of a wallet it can't sign for

Solana recently gained a native **secp256r1 precompile** (SIMD-0075,
`Secp256r1SigVerify1111111111111111111111111`) that *can* verify P-256 signatures
on-chain. The passkey still cannot sign a *transaction* — but a P-256 verification
can be placed *inside* a transaction as an instruction. Every passkey-gated vault
operation is two instructions:

```
Transaction (signed/paid by ANY ordinary ed25519 key — facilitator, fee payer,
             doesn't matter; this key has no authority over the vault):

  [0] secp256r1 verify    → "here is a P-256 signature, a pubkey, and a message.
                             Precompile: verify the signature."
  [1] vault instruction   → "look back at instruction [0]. Did the precompile pass?
                             Is the pubkey MY bound passkey? Does the challenge inside
                             the WebAuthn envelope equal sha256(the operation I'm
                             authorizing)? Only then proceed."
```

The vault's `verify/webauthn.rs` does instruction [1]'s check: it reconstructs the
WebAuthn digest (`authenticatorData ‖ sha256(clientDataJSON)`), introspects the
sibling precompile instruction to confirm it verified that exact message against the
vault's stored passkey pubkey, then parses the `clientDataJSON` to extract the
challenge and confirms it equals `sha256(operation_message)`.

The payoff is a clean **decoupling**:

- **Who pays / sends the transaction** → any ed25519 key (the facilitator, a relayer).
  This key has zero authority over the funds.
- **Who *authorizes* the operation** → your hardware passkey, verified on-chain by the
  precompile.

The unstealable key gets to be the boss without ever needing to be a Solana keypair.
This bridge is the cleverest and most load-bearing piece of the entire stack: it is
what makes "non-custodial, hardware-secured, agent-speed" possible at the same time.

---

## 5. Proof-of-control: the same bridge, now for identity

The bridge above authorizes *spending*. The newest application of it authorizes
*identity* — proving you control a vault without moving a cent.

A verifier builds the same two-instruction pair — `[secp256r1 verify, prove_passkey]`
— over a challenge, and **simulates** it (`simulateTransaction`, signature
verification disabled). The passkey "signs" via the precompile *instruction data*,
not a transaction signature, so there is **no fee payer, no signer, no state change,
no transaction landing on chain.** If the simulation returns no error, the passkey
controlling that vault provably signed that challenge.

This is the Solana equivalent of Ethereum's EIP-1271 ("ask the smart-wallet whether a
signature is valid"). It turns the passkey's "I can't directly talk to the chain"
limitation into a **read-only identity proof** — verified by the user's own program.

The mechanism is proven: the precompile executes during `simulateTransaction` on
mainnet, and the full flow (correct passkey accepted; wrong passkey and wrong
challenge rejected) passes on a local validator.

---

## 6. What this unlocks for wallet-holders

A keypair can only sign. A program can enforce, prove, delegate, and recover. So a
Dexter wallet can offer things a raw-keypair wallet — or a custodial one — structurally
cannot:

- **Gated access to anything, not just payments.** "Prove your vault to unlock X" —
  premium tiers, early features, holders-only surfaces. Proof-of-control already does
  this.
- **Portable, account-free reputation.** The vault has an on-chain identity; a holder
  can prove their agent's track record across services without signing up anywhere.
- **Capped sub-authorities for the holder's own agents.** Mint a scoped session key —
  "spend up to $5/day, expires in 24h, these programs only" — non-custodially,
  because the passkey authorizes the delegation on-chain. (This surfaces a capability
  the wallet already has: the Swig role model.)
- **Recovery-as-a-service.** `rotate_passkey` + `force_release` mean "lose your device,
  keep your wallet" — a real answer to the seed-phrase failure mode.
- **Programmable spend rules.** Spend limits, allowlists, time locks — wallet-level
  guarantees a stamp cannot make.

The connecting thread, one more time: **a keypair can only sign; a program can
enforce, prove, delegate, and recover.** The programmability is the moat.

---

## 7. Where this is genuinely new

The *concept* of a smart-wallet proving control is old and proven — Ethereum has had
EIP-1271 since 2018, and it underpins every smart-wallet sign-in on EVM. What is new
is doing it on **Solana, via passkeys**, because the building block underneath —
the secp256r1 precompile (SIMD-0075) — is recent. The floor only just got poured.
That is precisely why there is no established "Solana smart-wallet identity" standard
yet, and why OTS is positioned to define one rather than reinvent a wheel.

| Primitive | Role | Maturity |
|---|---|---|
| Smart-wallet identity (EIP-1271) | The concept being mirrored | Ethereum, since 2018 — proven |
| secp256r1 precompile (SIMD-0075) | The Solana building block that makes it possible | Recent — genuinely new ground |
| WebAuthn / FIDO2 | The unstealable-key standard | Industry standard, hardware-backed |
| OTS | The standard tying them into non-custodial spending **and identity** | Draft v1, reference live on mainnet |

The Dexter wallet sits exactly at this intersection: a proven idea, a new Solana
primitive, hardware-grade keys, woven into a standard. That intersection is the
differentiator — and it is defensible because most of the industry has not yet
noticed the floor is now there to build on.
