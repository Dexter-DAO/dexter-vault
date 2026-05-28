# Security Model — dexter-vault

**Program:** `Hg3wRaydFtJhYrdvYrKECacpJYDsC9Px7yKmpncj2fhc` (Solana mainnet)
**Audit status:** Not yet externally audited. Funding in flight.
**Document status:** Pre-audit self-review (v1, 2026-05-10)

This document is the authoritative description of the security properties enforced by the dexter-vault program. It is intended for external auditors, technical reviewers, and second/third implementers of the Open Tabs Standard (OTS). It is also the registry of known issues with their reasoning and remediation status.

If you find a discrepancy between this document and the on-chain program, **the on-chain program is authoritative.** Please open an issue.

---

## 1. Scope

dexter-vault is an Anchor program that gates withdrawal from a buyer's bound Swig smart-wallet. It enforces the following on-chain invariants:

1. **Withdrawal gate.** The buyer's funds can only leave their bound Swig wallet after (a) the buyer's passkey signs a `request_withdrawal`, (b) a cooling-off period elapses, and (c) zero tabs are outstanding.
2. **Bound-once Swig.** A vault's `swig_address` can be set exactly once via `set_swig`. It cannot be rebound.
3. **Bounded session role.** Dexter's session role on the bound Swig is granted at onboarding with `tokenLimit`, `programAll`, and a TTL — these limits are enforced by the Swig program, not by dexter-vault.
4. **Counter-based tab tracking.** `pending_voucher_count` is a monotonic counter incremented by Dexter's session signer on tab open and decremented on settle. The counter is the load-bearing gate behind property (1).

This document is concerned only with what dexter-vault itself enforces. Related security properties enforced by the Swig program are noted but not the primary subject here.

---

## 2. Trust assumptions

### 2.1 Trusted components

| Component | Why trusted |
|---|---|
| Solana consensus and runtime | Network-level assumption. Out of scope. |
| `Secp256r1SigVerify1111111111111111111111111` precompile | Solana-native signature verification. Solana Foundation's responsibility. |
| Swig smart-wallet program | Used for bounded session-role enforcement. Subject to its own audit by Anagram (Swig authors). |
| dexter-vault program (this codebase) | **The subject of this document.** Subject to forthcoming external audit. |
| WebAuthn / FIDO2 specification | Industry standard, IETF/W3C-governed. Hardware-backed authenticator security model assumed. |

### 2.2 Untrusted components

| Component | Why untrusted |
|---|---|
| The buyer | May attempt to drain mid-tab, replay an old request, or rebind the wallet. |
| The seller | May attempt to over-claim against a tab. |
| The facilitator (Dexter operations) | May attempt to inflate vouchers, replay claims, or settle without authorization. |
| The network between actors | May MITM, replay, or modify in-flight traffic. |
| The browser / authenticator host | Assumed to honor WebAuthn semantics but may be compromised; relying-party origin pinning is the mitigation. |

### 2.3 What the buyer's passkey trusts

The passkey-secured root authority is, by design, the strongest authority on the vault. It can:

- Bind the Swig (once)
- Request a withdrawal
- Finalize a withdrawal (subject to the gate)

It **cannot**:

- Rebind the Swig after binding
- Bypass the cooling-off period
- Bypass the `pending_voucher_count` gate
- Spend funds directly (spending goes through the Swig's session role, which is controlled by Dexter)

The vault is, by construction, NOT a "passkey can do anything" wallet. Even the user's own passkey is subject to the gate.

### 2.4 Swig authority layout (three roles)

The bound Swig is created with three authorities. Understanding their separation is load-bearing for the custody model:

| Role | Authority type | Actions | Held by | Can spend? |
|---|---|---|---|---|
| 0 | Ed25519 | `manageAuthority` only | The transaction fee payer at create time — the **facilitator** for the anonymous/guest flow, the **user's own wallet** for the authenticated flow | **No** |
| 1 | ProgramExec (dexter-vault, marker = `finalize_withdrawal` discriminator) | `all` | The dexter-vault program | Only via `finalize_withdrawal` (passkey-gated) |
| 2 | Ed25519Session (`DEXTER_SESSION_MASTER_KEY`) | `tokenLimit` + `programAll`, TTL | Dexter (facilitator) | Yes — bounded by Swig-enforced cap + TTL |

**Why role 0 exists.** The Swig SDK requires that any action performed *by* a ProgramExec authority (including `addAuthority`) be accompanied by a sibling instruction matching the registered marker. That is correct for withdrawals (`finalize_withdrawal` is the sibling) but impossible during enrollment, where no withdrawal exists yet. Role 0 is a plain Ed25519 `manageAuthority` authority that bootstraps the Swig and adds roles 1 and 2 atomically in the create transaction, with no marker sibling required. It is also the authority used to **re-grant the session role** (role 2) after its TTL lapses.

**What role 0 can and cannot do.** Role 0 holds `manageAuthority` and *nothing else*. Per the Swig permission model, `manageAuthority` is orthogonal to spend: an authority with only `manageAuthority` returns `false` from `canSpendSol`/`canSpendToken` and is not root (`isRoot() == false`). Role 0 can add, remove, and update Swig authorities; it **cannot move SOL or tokens**.

**Custody implication.** Funds leave the Swig only via (1) the user's passkey through the vault's `finalize_withdrawal` path (role 1, subject to cooling-off + the voucher gate) or (2) Dexter's capped/TTL'd session role (role 2). Role 0's authority-management power does not include spend, so the non-custodial property in §2.3 is preserved.

**Asymmetry between flows — noted as a trust difference:** in the **anonymous/guest flow** the facilitator holds role 0 (the manageAuthority key), because a brand-new agent has no key of its own to fee-pay or sign the create transaction. A compromised facilitator key could therefore add or remove authorities on a guest Swig — but still could not directly spend (no spend permission on role 0). In the **authenticated flow** role 0 is the user's own wallet, so authority management on that Swig is fully self-sovereign. The guest-flow facilitator-held manageAuthority is an accepted tradeoff of zero-account onboarding; it is bounded (no spend) and tracked here for completeness.

---

## 3. State machine

The vault has the following state fields (`programs/dexter-vault/src/state.rs`):

```rust
pub struct Vault {
    pub bump: u8,
    pub passkey_pubkey: [u8; 33],            // secp256r1 compressed pubkey
    pub swig_address: Pubkey,                // bound Swig (Pubkey::default() if unbound)
    pub cooling_off_seconds: i64,            // withdrawal delay
    pub pending_voucher_count: u32,          // outstanding tabs
    pub pending_withdrawal: Option<PendingWithdrawal>,
    pub supabase_user_id: [u8; 16],          // off-chain user identifier
}

pub struct PendingWithdrawal {
    pub amount: u64,
    pub destination: Pubkey,
    pub requested_at: i64,                   // unix timestamp from the passkey assertion
}
```

### 3.1 State transitions

```
┌─────────────────────────────────────────────────────────────────┐
│   uninitialized                                                  │
└────────┬─────────────────────────────────────────────────────────┘
         │ initialize_vault (anyone, paid setup)
         ▼
┌─────────────────────────────────────────────────────────────────┐
│   initialized, unbound                                           │
│   passkey_pubkey set, swig_address == Pubkey::default()          │
└────────┬─────────────────────────────────────────────────────────┘
         │ set_swig (passkey-signed)
         ▼
┌─────────────────────────────────────────────────────────────────┐
│   bound, idle                                                    │
│   pending_voucher_count == 0, pending_withdrawal == None         │
└────────┬─────────────────────────────────────────────────────────┘
         │
   ┌─────┴──────────────────────────┬──────────────────────┐
   │ settle_voucher(+1)             │ request_withdrawal   │
   │ (Dexter session signer)        │ (passkey-signed)     │
   ▼                                ▼                      │
┌─────────────────────┐         ┌─────────────────────┐    │
│   bound, tabs open  │         │   bound, idle,      │    │
│   count >= 1        │         │   withdrawal queued │◄───┘
└────────┬────────────┘         └────────┬────────────┘
         │ settle_voucher(-1)            │ finalize_withdrawal
         │ (Dexter session signer)       │ (passkey-signed,
         │                               │  REQUIRES count==0
         │                               │  AND cooling-off ≥ N)
         │                               ▼
         │                       ┌─────────────────────┐
         │                       │ withdrawal cleared  │
         │                       │ pending_withdrawal  │
         └─────────────────────► │ → None              │
                                 └─────────────────────┘
```

### 3.2 Instruction-by-instruction analysis

#### 3.2.1 `initialize_vault`

**Authority required:** Setup payer (any signer that pays rent).

**State changes:**
- Sets `passkey_pubkey` to `args.passkey_pubkey`
- Sets `cooling_off_seconds` to `args.cooling_off_seconds`
- Sets `supabase_user_id` to `args.supabase_user_id`
- Initializes `swig_address = Pubkey::default()`, `pending_voucher_count = 0`, `pending_withdrawal = None`

**Security checks:**
- `passkey_pubkey[0] == 0x02 || 0x03` (valid SEC1 compressed P-256 encoding)
- `cooling_off_seconds >= 0`
- PDA derivation: `seeds = [b"vault", supabase_user_id]` — one vault per Supabase user ID.

**Threat: bind to attacker's passkey.** An attacker calling `initialize_vault` with their own passkey before the legitimate user does will create a vault under their control. This is mitigated *off-chain* by the facilitator/dexter-api flow: legitimate vault creation happens within the authenticated `/api/passkey-vault` flow, which derives the Supabase user ID from a verified session. An attacker would need to (a) compromise the user's Supabase session, or (b) race the legitimate initialization. The on-chain program itself does not prevent this — it relies on the off-chain flow controlling who calls `initialize_vault` for which `supabase_user_id`.

**Mitigation gap:** consider adding an `initializer_pubkey` constraint or a setup-authority allowlist to the program if the off-chain controls are deemed insufficient.

#### 3.2.2 `set_swig`

**Authority required:** Passkey (WebAuthn assertion).

**State changes:**
- Sets `vault.swig_address = args.swig_address`

**Security checks:**
- `vault.swig_address == Pubkey::default()` (one-shot bind — can never be changed)
- Passkey assertion verifies via `verify_passkey_signed` over op-msg `b"set_swig" || swig_address_bytes`

**Threat: rebind to attacker's Swig.** Cannot happen — the bind is one-shot. Once `swig_address` is set, any subsequent `set_swig` call fails.

**Threat: bind to a Swig the user doesn't control.** The passkey signs over the Swig address, so the user must have intentionally signed. However, *intentionality* depends on the off-chain UI accurately showing the Swig address being bound. A malicious browser could substitute the Swig address before showing it to the user. This is a standard WebAuthn host-trust concern — relying-party origin pinning is the partial mitigation.

**UX consequence of one-shot bind:** if the user loses access to their Swig (e.g. all Swig authorities are compromised or lost), they cannot rebind a new Swig to the same vault. The vault is effectively orphaned — passkey-signed withdrawal requests will still work but no new spending is possible. This is by design (preventing a stolen-passkey attacker from rebinding), but it constrains recovery flows.

#### 3.2.3 `settle_voucher`

**Authority required:** Dexter session signer (currently a Keypair held by the facilitator).

**State changes:**
- If `args.increment == true`: `pending_voucher_count = pending_voucher_count.saturating_add(1)`
- If `args.increment == false`: `pending_voucher_count -= 1` (requires `> 0`)

**Security checks:**
- `dexter_session_signer: Signer<'info>` — must be a transaction signer.
- On decrement: `require!(pending_voucher_count > 0, VaultError::NoPendingWithdrawal)` — note the error code is misleading; tracked in issue #2.

**Threat: Dexter inflates `pending_voucher_count` to permanently lock the vault.** Possible. Dexter could call `settle_voucher(increment=true)` repeatedly without ever decrementing, eventually saturating at `u32::MAX`. The vault becomes permanently un-withdrawable.

**Mitigation:** Off-chain operational controls (the facilitator should only call `settle_voucher` in response to a real session). On-chain, this is currently unmitigated. Possible v1.1 improvements:
- A per-session-key rate limit (e.g. max N increments per N seconds)
- A user-callable "panic decrement" gated on no recent voucher activity
- An expiry on session-key authority (handled by Swig TTL, but not by dexter-vault directly)

**Threat: Dexter decrements without settling.** Possible. Dexter could decrement `pending_voucher_count` without actually settling a payment, effectively allowing the buyer to exit without paying. This harms Dexter (and any seller it represents), not the buyer. Out of scope for a buyer-protection model.

**Threat: counter overflow attack.** `saturating_add` caps at `u32::MAX = 4,294,967,295`. To overflow, a malicious session signer would need to send ~4 billion increment transactions, each costing transaction fees. Not economically meaningful.

**Threat: counter underflow.** Prevented by the `require!(> 0)` check. The underlying `-=` is safe given the require.

**Issue #2 follow-ups:**
- Misleading error code (`NoPendingWithdrawal` for what is really `NoPendingVoucher`).
- The "permanent lock if saturated" decision needs to be explicit. Current behavior: saturate silently. Recommended: either revert above a sanity threshold or document acceptance of the trade-off.

#### 3.2.4 `request_withdrawal`

**Authority required:** Passkey (WebAuthn assertion).

**State changes:**
- Sets `vault.pending_withdrawal = Some(PendingWithdrawal { amount, destination, requested_at })`.

**Security checks:**
- `drift = now - signed_at` (absolute value) `<= 300` seconds. Prevents stale assertions older than 5 minutes.
- Passkey assertion verifies over op-msg `b"request_withdrawal" || amount_le || destination_bytes || signed_at_le`.

**Threat: replay within the 300s window.** A snooped assertion is replayable as long as `now - signed_at <= 300`. The handler unconditionally overwrites `pending_withdrawal`. Consequences:

- If the user has *no* prior pending_withdrawal: replay is idempotent (sets it to what the user already intended).
- If the user has *finalized* one withdrawal and submitted a *new* `request_withdrawal` with different params: a replayed older assertion would overwrite the new request with the old one, resetting `requested_at` to the older timestamp. The older request would then become finalizable sooner than the user intended.

**Worst-case impact:** an attacker can shorten the cooling-off window for a *new* withdrawal request *if* they previously snooped an old assertion with matching `(amount, destination, signed_at)`. Not fund theft. Not unauthorized withdrawal. Just a confused-deputy on user intent.

**Mitigation roadmap (issue #2):**
- Add a monotonic nonce to the op-message (e.g. include `vault.pending_voucher_count` or a dedicated nonce field).
- Reject `request_withdrawal` if `signed_at <= vault.pending_withdrawal.requested_at`.
- Or document that the threat is acceptable and proceed.

**Threat: signed_at clock skew.** The 300-second window allows for legitimate clock drift between the browser and Solana. A malicious browser with adjusted system clock could submit assertions up to 300s in the future or past. Given the cooling-off period default is 86,400s (24 hours), a 300s skew on `requested_at` shifts the finalize-eligible time by at most 5 minutes — economically and practically immaterial.

#### 3.2.5 `finalize_withdrawal`

**Authority required:** Passkey (WebAuthn assertion).

**State changes:**
- Sets `vault.pending_withdrawal = None`.

**Security checks (in order):**
1. `vault.pending_withdrawal.is_some()` (something to finalize)
2. `vault.swig_address != Pubkey::default()` (Swig is bound)
3. `ctx.accounts.swig.key() == vault.swig_address` (the passed Swig matches)
4. `elapsed >= vault.cooling_off_seconds` (cooling-off elapsed)
5. **`pending_voucher_count == 0`** (the gate)
6. Passkey assertion verifies over op-msg `b"finalize_withdrawal" || amount_le || destination_bytes`

**The gate.** Check (5) is the load-bearing security property of the protocol. The buyer's own passkey signature is **rejected** by the on-chain program if `pending_voucher_count > 0`. This is verified by the adversarial test in `tests/drain-attempt.ts`.

**Note on side effects.** This handler only updates dexter-vault state. The actual *movement of funds* from the bound Swig to the destination must be a separate instruction in the same transaction, signed by the Swig's root authority (which dexter-vault has bound) or by an authority with sufficient Swig permissions. The current production flow performs the funds movement in a separate tx after `finalize_withdrawal` updates state. This is acceptable but worth being explicit about: dexter-vault's job is to gate the *eligibility* to withdraw; the actual transfer is enforced by the Swig program.

**Threat: replay after finalize.** Once finalized, `pending_withdrawal = None`. A replayed `finalize_withdrawal` would fail check (1). Safe.

**Threat: passkey assertion across operations.** The op-msg is distinct per operation (`finalize_withdrawal` vs `request_withdrawal` vs `set_swig`), so an assertion for one operation cannot be reused for another. Safe.

---

## 4. WebAuthn verification

See `programs/dexter-vault/src/verify/webauthn.rs`.

### 4.1 What is verified

For every passkey-gated instruction, `verify_passkey_signed` confirms:

1. **The previous instruction was a SIMD-0075 secp256r1 sigverify call** with:
   - The exact stored `passkey_pubkey` as the verifying pubkey
   - The message `authenticatorData || sha256(clientDataJSON)` (the WebAuthn-canonical signed digest)
2. **The signing instruction index matches** for sig/pubkey/message (no cross-instruction substitution).
3. **The `clientDataJSON` `challenge` field**, when base64url-decoded, equals `sha256(operation_message)`.

The SIMD-0075 precompile validates the signature itself; this module proves authorship over the specific operation.

### 4.2 What is NOT verified (deliberately or by gap)

| Property | Status | Reasoning / risk |
|---|---|---|
| `clientDataJSON.type == "webauthn.get"` | **Not enforced** | Risk: an assertion produced via `webauthn.create` (registration) could be misused if the registration challenge happened to equal the operation challenge. Real-world risk is low (registration ceremonies have different challenge formats) but should be enforced before audit. |
| `clientDataJSON.origin` pinning | **Not enforced on-chain** | The vault does not check that the assertion was produced against `https://dexter.cash`. An attacker who controls a different WebAuthn-enabled origin could potentially produce assertions usable against the vault. Mitigation: the WebAuthn passkey is registered to a specific RP ID; the authenticator should refuse to assert for a different RP ID. But the program does not cross-check. **Recommended:** add `rpIdHash` check inside `verify_passkey_signed` against a constant or per-vault stored RP-ID hash. |
| `authenticatorData.flags` User Present (UP) | **Not enforced** | UP bit indicates the user was present during the assertion. Some authenticators do not set this in all flows. Decision needed: enforce or document acceptance. |
| `authenticatorData.flags` User Verified (UV) | **Not enforced** | UV bit indicates biometric or PIN verification. Currently no UV check, allowing assertions from authenticators that did not require biometric/PIN. Decision needed for production. |
| `authenticatorData.signCount` | **Not enforced** | Sign count is a replay-detection signal at the authenticator level. We don't track it. Acceptable for our model (replay protection comes from operation-msg uniqueness + cooling-off). |
| JSON parsing strictness | **Custom minimal parser** | We do not pull in serde_json on-chain. The custom scanner looks for `"challenge":"`. Risk: a JSON value containing `"challenge":"` as a substring inside another field could confuse the parser. Today, the `clientDataJSON` produced by browsers is structurally consistent enough that this is not exploitable in practice, but a strict parser would be safer. |
| Duplicate-key JSON | **Not addressed** | If a malicious browser produces `{"challenge":"X","challenge":"Y",...}`, our parser returns the first match. Most JSON parsers accept duplicates and return the last; the WebAuthn spec does not normatively specify. Out of scope unless attacker controls the browser. |

These gaps are tracked in `Dexter-DAO/dexter-vault#1` (WebAuthn audit-prep).

### 4.3 Compute budget

The WebAuthn verification path is bounded:

- SIMD-0075 precompile call: cost paid by the SIMD-0075 instruction itself.
- Compose `authenticatorData || sha256(clientDataJSON)`: one SHA-256 call + memcpy.
- Locate `"challenge":"` in clientDataJSON: linear scan, ~300 byte JSON typical.
- base64url decode: linear over challenge bytes, ~43 bytes typical (32-byte digest encoded).
- Compare to `sha256(operation_message)`: one SHA-256 + 32-byte memcmp.

Total CU usage is well under any default instruction limit. Not a DoS vector.

---

## 5. Threat model summary

### 5.1 Attacks the vault prevents

| Attack | Mitigation |
|---|---|
| Buyer drains wallet mid-tab | `pending_voucher_count > 0` blocks `finalize_withdrawal` (verified by `tests/drain-attempt.ts`) |
| Buyer rebinds Swig after compromise | `set_swig` one-shot constraint |
| Buyer bypasses cooling-off | `elapsed >= cooling_off_seconds` check in `finalize_withdrawal` |
| Facilitator settles without authorization | Settlement happens via Swig session role with bounded `tokenLimit` (Swig-enforced) |
| Replay across operations | Distinct op-msg prefix per instruction (`set_swig`, `request_withdrawal`, `finalize_withdrawal`) |
| Cross-instruction signature substitution | `verify_passkey_signed` requires matching instruction indices in SIMD-0075 offsets |
| Stale passkey assertion | 300-second `drift` check in `request_withdrawal` |

### 5.2 Attacks the vault does NOT prevent (by design or by gap)

| Attack | Why not | Mitigation |
|---|---|---|
| Dexter operationally inflates `pending_voucher_count` | Trust assumption — Dexter is trusted not to misbehave operationally | Off-chain ops controls; v1.1 may add rate limits |
| Compromised passkey | Standard WebAuthn assumption | Hardware-backed authenticator; biometric gating; off-chain account recovery (if implemented) |
| Browser substitutes operation parameters | Standard WebAuthn host-trust concern | Origin pinning at RP ID level (Recommended additions in §4.2) |
| Snooped `request_withdrawal` replay within 300s | Lack of nonce in op-msg | v1.1 to add nonce — issue #2 |
| Counter saturation locking vault | `saturating_add` design | Operational controls; v1.1 may add panic-decrement |

### 5.3 Out-of-scope

- Compromise of Solana itself (consensus, runtime).
- Compromise of the Swig program.
- Compromise of the WebAuthn standard or the user's authenticator.
- Off-chain compromise of the Supabase user-account flow that feeds `initialize_vault`.

---

## 6. Known issues register

| ID | Title | Severity | Status |
|---|---|---|---|
| [vault#1](https://github.com/Dexter-DAO/dexter-vault/issues/1) | WebAuthn verification audit-prep (origin pinning, UP/UV flags, JSON strictness) | High | Open, pre-audit |
| [vault#2](https://github.com/Dexter-DAO/dexter-vault/issues/2) | Replay nonce + saturating math | Medium | Open, pre-audit |
| [facilitator#45](https://github.com/Dexter-DAO/dexter-facilitator/issues/45) | Fire-and-forget vault increment race at session-open | High | Open, pre-audit |
| [facilitator#46](https://github.com/Dexter-DAO/dexter-facilitator/issues/46) | Crossmint vs vault path coexistence decision capture | Low (informational) | Open |

---

## 7. Test coverage

### 7.1 Adversarial tests in this repo

| Test file | What it proves |
|---|---|
| `tests/drain-attempt.ts` | Buyer cannot finalize withdrawal while `pending_voucher_count > 0`. Verifies the load-bearing gate end-to-end. |
| `tests/withdrawal-flow.ts` | Happy-path request-then-finalize works after cooling-off and zero tabs. |
| `tests/settle-voucher.ts` | Increment and decrement work correctly; double-decrement from zero rejected. |
| `tests/initialize-vault.ts` | Vault initialization correctness. |
| `tests/set-swig.ts` | One-shot bind constraint. |

### 7.2 What is NOT covered by tests yet

- Replay of `request_withdrawal` within 300s window (issue #2).
- Counter saturation behavior.
- WebAuthn verification with adversarial `clientDataJSON` (issue #1).
- Real-device passkey fixtures (currently synthetic P-256 keys are used in tests).

To be added before audit kickoff.

---

## 8. External audit roadmap

| Phase | Owner | Target |
|---|---|---|
| Pre-audit self-review | Dexter team | In progress — items in `vault#1`, `vault#2`, `facilitator#45` |
| Audit firm selection | Dexter team | Funded by seed round |
| Audit kickoff | Audit firm | T+0 (post-funding) |
| Audit completion | Audit firm | T+8 weeks (estimated) |
| Public audit report | Dexter team | T+10 weeks (estimated) |
| Production deployment of audit fixes | Dexter team | T+12 weeks (estimated) |

This document will be updated at each phase.

---

## 9. Disclosure policy

Security issues discovered in dexter-vault should be reported to:

- **Primary:** branch@dexter.cash
- **Encrypted:** PGP key available on request

Please do **not** open public GitHub issues for unfixed vulnerabilities. We will respond within 48 hours and coordinate disclosure.

Standard responsible-disclosure window: 90 days from initial report to public disclosure, extendable by mutual agreement.

---

## 10. Version history

| Version | Date | Changes |
|---|---|---|
| 1.0 | 2026-05-10 | Initial document. Pre-audit self-review. |
