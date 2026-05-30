# Vault program v2 — session keys + layout improvements

**Status:** Design APPROVED 2026-05-30. All five open decisions in §12 confirmed. Implementation can begin.

**Date:** 2026-05-30

**Author:** Branch + Claude, working session.

**Audience:** Anyone implementing or auditing the v2 vault program. Anyone writing the OTS standards proposal update. Anyone implementing the @dexterai/x402/tab SDK against this program.

---

## 1. Why a v2 at all

v1 of the vault program is live on mainnet with 9 instructions, including the recently-added `prove_passkey`. Two real vaults exist (Branch's 7FE9 and one other test vault). v1 works.

But v1 was designed with the on-chain seller-protection invariant as the only goal. The off-chain protocol that rides on top of v1 — how a buyer authorizes streaming charges to a seller without burning their thumb off via biometric prompts — does not exist yet. v2 adds the on-chain primitive that makes that off-chain protocol possible: session-key registration.

Since we're touching the program anyway, this is also the cheapest moment to bake in a small number of layout improvements we'd otherwise carry forward forever. **The existing two vaults can and will be destroyed in the migration.** There is no public install base to preserve.

## 2. The headline change: `register_session_key`

### 2.1 What it does

Adds a new instruction that records a session-key authorization on the vault. The passkey signs a deterministic message stating "I authorize this session pubkey to act on my behalf, up to this amount, until this expiry, only for this counterparty." The program verifies the passkey signature via the existing SIMD-0075 secp256r1 precompile pattern (same as `prove_passkey`).

After registration, the session key is recognized as a valid signer for **off-chain vouchers only**. The session key never directly invokes any on-chain instruction in this v1 of the feature. Vouchers signed by the session key travel between buyer and seller off-chain; the seller verifies them locally; at tab close the facilitator aggregates and calls the existing `settle_voucher` with the recorded `dexter_authority`.

### 2.2 The registration message format

Bytes the passkey signs (the same bytes the program reconstructs and verifies):

```
[ 32 bytes ] domain separator literal "OTS_SESSION_REGISTER_V1\0\0\0\0\0\0\0\0\0"
[ 32 bytes ] program ID
[ 32 bytes ] vault PDA
[ 32 bytes ] session ed25519 pubkey
[  8 bytes ] max_amount (u64 LE, atomic units)
[  8 bytes ] expires_at (i64 LE, unix seconds)
[ 32 bytes ] allowed_counterparty pubkey
[  4 bytes ] nonce (u32 LE)
```

Total: 180 deterministic bytes. SHA-256'd, fed to the precompile, verified against the vault's `passkey_pubkey`.

Decisions baked in:

- **Domain separator** prevents cross-protocol replay. A passkey signature meant for a session registration can never be misinterpreted as a withdrawal or a voucher.
- **Program ID** prevents cross-fork replay. If the vault program is ever forked or redeployed, signatures don't carry over.
- **Vault PDA** prevents cross-vault replay. A session registration for vault A can't be used against vault B.
- **Counterparty is required, not optional.** No "any seller" wildcard in v1. This is the conservative posture. Multi-seller tabs are a future extension (issue #5).
- **Nonce is u32.** A vault can issue 4B sessions before wrapping. Combined with `expires_at`, gives us per-session uniqueness.
- **No `issued_at` field.** Expiry is absolute; issuance time is implicit. Avoids clock-skew handling.

### 2.3 Instruction args

```rust
pub struct RegisterSessionKeyArgs {
    pub session_pubkey: [u8; 32],
    pub max_amount: u64,
    pub expires_at: i64,
    pub allowed_counterparty: Pubkey,
    pub nonce: u32,
    // WebAuthn passkey signature components (same as prove_passkey)
    pub client_data_json: Vec<u8>,
    pub authenticator_data: Vec<u8>,
}
```

The `clientDataJSON` `challenge` field must base64url-decode to `sha256(registration_message)` where `registration_message` is the 180 bytes above.

### 2.4 Account constraints

```rust
pub struct RegisterSessionKey<'info> {
    #[account(mut)]
    pub vault: Account<'info, Vault>,
    /// CHECK: instructions sysvar for precompile sibling verification
    #[account(address = sysvar::instructions::ID)]
    pub instructions_sysvar: AccountInfo<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
}
```

The `payer` is the facilitator co-signer, paying the realloc rent for the new field on the Vault account (covered by the existing fee-payer model).

### 2.5 Behavior

- **If `vault.active_session` is `None`:** verify passkey signature, then write `Some(SessionRegistration { ... })` to the vault.
- **If `vault.active_session` is `Some` and not expired:** reject with `SessionAlreadyActive`. (Future: support multi-session, but v1 is single-session.)
- **If `vault.active_session` is `Some` and expired:** allow overwrite. This is how sessions "rotate."
- **`expires_at` must be in the future** (using `Clock::get()?.unix_timestamp`).
- **`max_amount` must be > 0.** A zero-cap session is meaningless.

### 2.6 Companion: `revoke_session_key`

A small companion instruction that lets the buyer's passkey explicitly tear down a session before its expiry. This is the "I closed my tab early" path and the "I think this session leaked" path.

```rust
pub struct RevokeSessionKeyArgs {
    pub client_data_json: Vec<u8>,
    pub authenticator_data: Vec<u8>,
}
```

Message format:

```
[ 32 bytes ] domain separator literal "OTS_SESSION_REVOKE_V1\0\0\0\0\0\0\0\0\0\0\0"
[ 32 bytes ] program ID
[ 32 bytes ] vault PDA
[ 32 bytes ] session ed25519 pubkey (the one being revoked, from active_session)
```

96 bytes. Verifies the passkey, then sets `vault.active_session = None`.

## 3. The Vault account layout change

### 3.1 Current (v1) Vault

```rust
pub struct Vault {
    pub bump: u8,
    pub passkey_pubkey: [u8; 33],
    pub swig_address: Pubkey,
    pub cooling_off_seconds: i64,
    pub pending_voucher_count: u32,
    pub pending_withdrawal: Option<PendingWithdrawal>,
    pub supabase_user_id: [u8; 16],
    pub dexter_authority: Pubkey,
}
```

### 3.2 Proposed (v2) Vault

```rust
pub struct Vault {
    pub version: u8,                                  // NEW — see §4
    pub bump: u8,
    pub passkey_pubkey: [u8; 33],
    pub swig_address: Pubkey,
    pub cooling_off_seconds: i64,
    pub pending_voucher_count: u32,
    pub pending_withdrawal: Option<PendingWithdrawal>,
    pub supabase_user_id: [u8; 16],                   // see §5 for the discussion
    pub dexter_authority: Pubkey,
    pub active_session: Option<SessionRegistration>,  // NEW — the session-key field
}

pub struct SessionRegistration {
    pub session_pubkey: [u8; 32],
    pub max_amount: u64,
    pub expires_at: i64,
    pub allowed_counterparty: Pubkey,
    pub nonce: u32,
    pub spent: u64,            // running total — updated when settle_voucher closes a tab
}
```

Notes:

- `version: u8` is at the top so any future migration code can branch on a single byte read.
- `active_session` is `Option<>` because most of the time the vault has no live session. When it's `None`, the account is the same size as if the field were absent (Anchor packs Options as 1-byte discriminator + payload).
- `spent: u64` lives on `SessionRegistration` so we can track cumulative spend against the cap even across multiple tab opens within the same session (multi-tab sessions are a future feature; the field is here so we don't have to migrate again to add it).

### 3.3 Existing vaults

**Existing v1 vaults will be destroyed in the v2 migration.** Specifically:
- Branch's 7FE9 vault
- One other test vault

This is acceptable because:
1. There are exactly two vaults
2. Both belong to internal testing
3. No external user has been told about OTS yet (per Branch, 2026-05-30)
4. Both can be re-enrolled fresh against v2 with no user-facing impact

The migration path:
- v2 program deploys to a new program ID, OR
- v2 program reuses the same ID and existing vault accounts simply become unreadable (returning `AccountDidNotDeserialize`) until they're re-enrolled

Recommendation: **reuse the program ID, let existing accounts fail-to-deserialize, re-enroll the two test vaults fresh.** Cleaner than juggling two program IDs.

## 4. Why `version: u8`

A single version byte at the top of the Vault account costs nothing and gives us three things:

1. **Cheap branching on read.** Any consumer can read byte 0 and immediately know which layout to expect. No "try to deserialize, if it fails try the older layout" dance.
2. **Forward compatibility.** When v3 ships, the v2-aware reader sees `version=3` and knows it doesn't understand the rest, so it errors cleanly with `UnsupportedVaultVersion` instead of producing garbage data.
3. **Audit signal.** A v2-bound program that finds `version=1` rejects the call. A future v3-bound program that finds `version=1` or `version=2` can choose to handle each.

The byte is essentially free (one byte of account rent ≈ $0.000000007). The optionality it preserves is enormous.

## 5. The `supabase_user_id` question (OPEN)

### 5.1 What it is today

A 16-byte field on the Vault account containing the Supabase user UUID of the buyer who enrolled the vault. Set at init via `initialize_vault`, never modified after.

### 5.2 Why it's weird on chain

OTS is meant to be a standards-track protocol. Other operators (not just Dexter) should be able to implement OTS-compliant vault programs. None of those operators have a Supabase database. None of their users have UUIDs in our format.

A `supabase_user_id` field on chain is therefore one of three things:
1. **Dexter-specific.** OK in v1, but it should be marked as "operator-specific identity claim, opaque to the protocol" if it stays.
2. **Generic identity claim.** Rename to `identity_claim: [u8; 16]` or `identity_claim: [u8; 32]`, define semantics as "operator-defined". Dexter uses it for Supabase UUIDs; another operator uses it for whatever.
3. **Off-chain entirely.** Remove the field. The mapping from passkey to user lives in the operator's own database, not on chain.

### 5.3 The argument for each

**Option 1 — Keep `supabase_user_id` (status quo).** Pro: zero work. Con: when the OTS standards proposal is written, this field is awkward — either we hide it in the spec ("operators MAY include an opaque identity claim of up to 16 bytes") or we name it explicitly and look Dexter-centric.

**Option 2 — Generic `identity_claim: [u8; N]`.** Pro: same on-chain footprint, cleanly extensible, OTS-spec-friendly. Con: tiny renaming work across the codebase.

**Option 3 — Remove entirely.** Pro: cleanest on-chain footprint. Con: loses the ability to do server-side queries like "which vault belongs to Branch" without a separate DB table mapping passkey → user. We already have such a table (the user-vaults DB) so the on-chain field is arguably redundant.

### 5.4 Recommendation

**Option 2 — rename to `identity_claim: [u8; 16]`**, document semantics as "an opaque identity claim defined by the operator; the protocol does not interpret these bytes."

Dexter continues to put Supabase UUIDs there. Future operators put whatever they want. The OTS spec describes the field generically. Off-chain code that reads vault state continues to work because it's just a renamed field.

Bumping the byte count to 32 would be cleaner long-term (UUIDs fit easily in 16 bytes but other identity systems might want more). 16 → 32 costs 16 extra bytes per vault, ~$0.0000001 in rent. Worth it if we're already doing a layout migration.

**Sub-recommendation: rename AND bump to `identity_claim: [u8; 32]`.**

## 6. The multi-passkey question (OPEN, mostly deferred)

### 6.1 Today

A vault is bound to exactly one passkey. Lose the device, you go through the 7-day force-release path.

### 6.2 What multi-passkey would unlock

Several enrolled passkeys on one vault, any of which can sign withdrawals. Lose your phone, your laptop still works. This is what consumer wallets call "social recovery via own devices."

### 6.3 Why this design doc DOES NOT do multi-passkey

It's a bigger change than session keys:
- The vault account layout needs `passkey_pubkeys: Vec<[u8; 33]>` or a fixed array
- Every passkey-signed instruction (`set_swig`, `request_withdrawal`, `finalize_withdrawal`, `force_release`, `rotate_passkey`, `prove_passkey`, `register_session_key`, `revoke_session_key`) needs to accept "any one of N pubkeys verified"
- The "who can add a passkey" policy is a real decision (any-of vs threshold)
- The migration story (existing single-passkey vaults adding their second one) is its own thing

It's a real follow-up project (filed as issue #8 on dexter-vault), and it deserves its own design doc. Trying to fold it into the session-key release would balloon the scope and delay session keys, which are the immediate unblock for browser-native streaming.

### 6.4 What v2 DOES do to ease the future migration

Leave room for it. Two cheap moves:
1. The `version: u8` byte (already proposed in §4) makes a future Vault layout change identifiable cleanly.
2. Document explicitly in the v2 program comments that `passkey_pubkey: [u8; 33]` is the v2 single-passkey field and that v3 may replace it with a list.

That's enough. No multi-passkey work in v2.

## 7. Smaller decisions

### 7.1 `cooling_off_seconds: i64` → `u32`

`i64` allows negative cooling-off, which is meaningless. `u32` caps at ~136 years, which is plenty. Saves 4 bytes per vault. Trivially worth it during a layout change.

### 7.2 `pending_voucher_count: u32`

Fine. Stays.

### 7.3 `bump: u8`

Stays.

### 7.4 `pending_withdrawal: Option<PendingWithdrawal>`

Fine. Stays. The realloc concern (adding more `Option` fields later) is moot because we have `version: u8` now and any future layout change rebuilds the account anyway.

## 8. The full v2 Vault layout, decided

```rust
pub struct Vault {
    pub version: u8,                                  // NEW (§4)
    pub bump: u8,
    pub passkey_pubkey: [u8; 33],
    pub swig_address: Pubkey,
    pub cooling_off_seconds: u32,                     // CHANGED (§7.1)
    pub pending_voucher_count: u32,
    pub pending_withdrawal: Option<PendingWithdrawal>,
    pub identity_claim: [u8; 32],                     // RENAMED + RESIZED (§5)
    pub dexter_authority: Pubkey,
    pub active_session: Option<SessionRegistration>,  // NEW (§2)
}
```

This is the layout being shipped if the recommendations in §5 and §7.1 are accepted. If any are deferred, the v2 layout still includes `version` and `active_session`; the others stay v1-shaped.

## 9. New / changed instructions in v2

| Instruction | Status | Notes |
|---|---|---|
| `initialize_vault` | CHANGED | Writes `version=2`, takes `identity_claim` arg instead of `supabase_user_id`, takes `cooling_off_seconds: u32` |
| `set_swig` | unchanged | |
| `settle_voucher` | unchanged in v2 | (Future v3: optionally consult `active_session.spent` for cap enforcement) |
| `request_withdrawal` | unchanged in v2 | (Future: optionally accept session-key signature for withdrawal-from-vault. v2 keeps passkey-only.) |
| `finalize_withdrawal` | unchanged | |
| `force_release` | unchanged | |
| `rotate_passkey` | unchanged | |
| `rotate_dexter_authority` | unchanged | |
| `prove_passkey` | unchanged | |
| `register_session_key` | **NEW** (§2) | The headline feature |
| `revoke_session_key` | **NEW** (§2.6) | Buyer tears down a session early |

Total: 11 instructions (was 9).

## 10. What this DOES NOT change

- The on-chain seller-protection invariant. `finalize_withdrawal` still rejects when `pending_voucher_count > 0`. The session-key layer is purely additive for off-chain voucher authorization.
- The `dexter_authority` model. `settle_voucher` still requires the recorded operator key.
- The cooling-off path. Identical semantics.
- The `force_release` recovery path. Identical semantics.
- The `prove_passkey` SIWX/EIP-1271-equivalent surface. Identical semantics.

Session keys never directly mutate the withdrawal-gating state. They only authorize off-chain voucher signing, which the seller verifies and the facilitator aggregates into the same `settle_voucher` call the protocol has always used.

## 11. The off-chain protocol layered on top

This belongs in the SDK design doc (`dexter-x402-sdk/docs/DESIGN-tab-streaming.md` §4.2), not here. Brief recap so this doc is self-contained:

1. Buyer's SDK generates an in-memory ed25519 keypair (the session key).
2. Buyer's passkey signs the 180-byte registration message authorizing that session key with explicit limits.
3. Facilitator submits `register_session_key` instruction with the passkey signature; the program verifies and writes `active_session` to the vault.
4. For the lifetime of the session, the SDK signs vouchers using the session key. Each voucher carries: payload + sessionPubkey + sessionRegistration + sessionSignature.
5. Seller verifies the registration's passkey signature once (cached) and each voucher's session signature locally (microseconds).
6. At tab close, the facilitator presents the cumulative voucher and calls the existing `settle_voucher`.
7. The session key is discarded from buyer memory. Optionally, the buyer's passkey signs a `revoke_session_key` to explicitly tear it down on chain.

## 12. Decisions (all CONFIRMED 2026-05-30)

1. **§5 identity_claim.** CONFIRMED: rename `supabase_user_id` → `identity_claim`, resize from `[u8; 16]` to `[u8; 32]`. Operator-defined opaque bytes; the protocol does not interpret them. Dexter continues to write Supabase UUIDs.
2. **§7.1 cooling_off_seconds: u32.** CONFIRMED: change from `i64` to `u32`. Negative values are meaningless; u32 caps at ~136 years which is enough.
3. **Multi-session-per-vault.** CONFIRMED: v2 enforces single-session. Multi-seller-from-one-session is future work tracked as [Dexter-DAO/dexter-vault#5](https://github.com/Dexter-DAO/dexter-vault/issues/5).
4. **Session-revocation grace.** CONFIRMED: `revoke_session_key` is immediate. Vouchers signed after on-chain revocation are intentionally void. Sellers learn via the next voucher's failed registration verification.
5. **Migration strategy.** CONFIRMED: reuse program ID. Existing v1 vault accounts become unreadable under v2 (`version` byte at offset 0 reads as garbage). The two existing test vaults' swigs are swept manually pre-upgrade to recover the ~$1 of USDC; the dead vault PDAs are left as zombies. No `migrate_v1_to_v2` instruction.

## 13. Next steps once this doc is approved

1. Branch approves §5, §7.1, and the rest of §12.
2. Write the v2 program — new `Vault` struct, two new instructions, updated `initialize_vault`.
3. Update `OTS-STANDARDS-PROPOSAL.md` to specify the session-key extension.
4. Update `dexter-x402-sdk/docs/DESIGN-tab-streaming.md` to point at the new instruction format.
5. Deploy v2 to mainnet (same program ID; existing accounts become unreadable).
6. Re-enroll Branch's 7FE9 and the other test vault fresh against v2.
7. Phase 2 of the SDK can begin — `openTab()` becomes implementable with a real on-chain target.

---

**End of design.** Decisions captured. No code touched. Awaiting approval before implementation.
