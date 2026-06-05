# migrate_v3_to_v4 Implementation Plan (Phase 1 — migration half)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the `migrate_v3_to_v4` instruction that reallocs existing V3 vault accounts to the enlarged V4 layout (which Phase 1 / LockedClaim adds to `Vault` and `SessionRegistration`), so no live V3 vault freezes when the typed `finalize_withdrawal` reservation check ships.

**Architecture:** Unlike the `migrate_v2_to_v3` template (commit `7284985`), V3→V4 has TWO struct-growth points and one is INTERIOR for `active_session = Some` vaults — so the template's "append-at-end + zero-fill-the-tail" trick does NOT apply. Instead this migration **decodes the old account with a frozen V3-shaped struct, then re-encodes it as V4 with the five new fields zeroed.** This is shuffle-proof and offset-proof: Borsh computes the layout, we never hand-compute an interior offset. The decode is safe (no chicken-and-egg) because V3 accounts are NOT shorter than the V3 struct — they match it exactly; the chicken-and-egg only bit v2→v3 because those accounts were shorter than the then-current struct.

**Tech Stack:** Anchor/Rust (Solana program), the deployed program `Hg3wRaydFtJhYrdvYrKECacpJYDsC9Px7yKmpncj2fhc`, ts-mocha mainnet tests (secp256r1 precompile is mainnet-only).

---

## CANONICAL SOURCES (read before any task — these supersede the stale A-to-Z Phase 1 steps)
- `dexter-thesis/SEAM-SPEC-credex-meter-meets-lockedclaim.md` (SIGNED) — the binding field list + non-collision guarantees.
- `dexter-thesis/V0.3-IMPLEMENTATION-RISK-DECISIONS.md` — LockedClaim engineering spec.
- `programs/dexter-vault/src/instructions/migrate_v2_to_v3.rs` (commit `7284985`) — the template for authority-gate, rent-top-up, AccountInfo handling. The DECODE/RE-ENCODE strategy here differs (see Architecture).
- The A-to-Z doc's Phase 1 numbered steps are STALE (predate the meter; use the rejected sequence-based XOR guard). Reference only.

## THE FIELD LIST (final, binding, from the LockedClaim owner)
```
Vault account additions (3× u64 = 24 bytes), appended AFTER active_session:
  outstanding_locked_amount: u64
  total_crystallized_amount: u64
  total_settled_amount: u64

SessionRegistration account additions (u64 + u32 = 12 bytes), appended at struct end:
  crystallized_cumulative: u64
  last_locked_sequence: u32
```

## GROUND TRUTH (verified on mainnet 2026-06-05)
- 277 total vault accounts: **262 V2** (frozen test junk, accepted stale), **8 V3** (all 305 bytes), 7 weird version bytes (mid-migration/corrupt junk).
- Of the 8 V3: **6 have `active_session = Some`** (the case requiring re-encode), **2 have `None`**.
- All 8 V3 are migratable only if we control their `dexter_authority`. Production vaults share the one `DEXTER_SESSION_MASTER_KEY` (`3SWJTQ4FB...`); test-run vaults minted throwaway authorities and may be unmigratable junk (acceptable, same as v2→v3).

## ⚠️ WHY THE TEMPLATE'S APPROACH DOES NOT TRANSFER (the core engineering point)
`migrate_v2_to_v3` worked by `resize(+16)` + zero-fill-tail because both new fields were the LAST two fields of the LAST field (`SessionRegistration` inside `Option<active_session>`), so the tail bytes landed exactly right.

V3→V4 is different. For a `Some` vault the V4 byte order is:
```
[...prefix...][ active_session{ SessionRegistration + crystallized_cumulative + last_locked_sequence } ][ outstanding_locked_amount + total_crystallized_amount + total_settled_amount ]
                                          ▲ +12 bytes INTERIOR (inside the Option)        ▲ +24 bytes at the tail
```
The SessionRegistration additions are INTERIOR (inside `active_session`, which is followed by the 3 new Vault fields). Zero-filling the tail would land the 24 Vault bytes correctly but leave the 12 SessionRegistration bytes reading the wrong region. **Append-zero-fill is therefore insufficient.** The migration must decode-then-re-encode.

---

## FILE STRUCTURE
| File | Responsibility | Change |
|---|---|---|
| `programs/dexter-vault/src/state.rs` | Vault + SessionRegistration structs, version consts | Add 5 fields, `VAULT_VERSION_V4 = 4` |
| `programs/dexter-vault/src/instructions/migrate_v3_to_v4.rs` | The migration instruction (decode V3 → re-encode V4) | NEW |
| `programs/dexter-vault/src/instructions/mod.rs` | Re-exports | +1 |
| `programs/dexter-vault/src/lib.rs` | Handler registration + version gates | register migrate_v3_to_v4; version-gate updates |
| `tests/migrate-v3-to-v4.ts` | Mainnet migration proof (Some + None vaults, read-back-every-field) | NEW |

> NOTE on the 5 fields: this plan ADDS the struct fields (so the migration has a real V4 to target) but does NOT add the four LockedClaim instructions or the frontier guard — those are the LockedClaim owner's instruction plan. The two plans MERGE; this half owns state-additions + migration only. The field additions here must match the LockedClaim plan's field list EXACTLY (the signed seam spec is the shared source).

---

## Task 1: Add V4 fields to the structs + VAULT_VERSION_V4

**Files:**
- Modify: `programs/dexter-vault/src/state.rs`

- [ ] **Step 1: Add the version constant**

After `pub const VAULT_VERSION_V3: u8 = 3;`, add:
```rust
/// V4 appends LockedClaim accounting: three u64s to `Vault`
/// (`outstanding_locked_amount`, `total_crystallized_amount`, `total_settled_amount`)
/// and `crystallized_cumulative: u64` + `last_locked_sequence: u32` to
/// `SessionRegistration`. Enlarges `Vault::INIT_SPACE`. New vaults init as V4.
pub const VAULT_VERSION_V4: u8 = 4;
```

- [ ] **Step 2: Add the three Vault fields AFTER active_session**

In `pub struct Vault`, after the `active_session: Option<SessionRegistration>` field (it is currently last), add:
```rust
    /// Sum of unsettled LockedClaim amounts for this vault. Rises at
    /// `lock_voucher`, falls at `settle_locked_voucher` / `recover_abandoned_lock`.
    /// The crystallized (buyer-irrevocable) reservation tier. Read by
    /// `finalize_withdrawal` to reject withdrawals that would violate the
    /// reservation. (Seam spec §1.)
    pub outstanding_locked_amount: u64,
    /// Lifetime monotonic locked-into-claim odometer at vault scope. Never decremented.
    pub total_crystallized_amount: u64,
    /// Lifetime monotonic settled-from-claim odometer at vault scope. Never decremented.
    pub total_settled_amount: u64,
```
(Order matters: these come AFTER `active_session` so V3 prefix offsets are preserved bit-for-bit — seam spec §5.)

- [ ] **Step 3: Add the two SessionRegistration fields at struct end**

In `pub struct SessionRegistration`, after `max_revolving_capacity: u64` (currently last), add:
```rust
    /// Session-scope monotonic locked-into-claim odometer; mirror of `spent`
    /// for the lock terminal path. Rises at `lock_voucher`. Never decremented.
    /// The XOR frontier `max(spent, crystallized_cumulative)` gates both
    /// terminal paths (seam spec §4). (Seam spec §1.)
    pub crystallized_cumulative: u64,
    /// Last voucher sequence number that was locked. Reserved for future
    /// out-of-order lock detection — NOT the XOR guard (the frontier is).
    pub last_locked_sequence: u32,
```

- [ ] **Step 4: Build to capture the new INIT_SPACE**

Run: `cd programs/dexter-vault && cargo build-sbf 2>&1 | tail -5` (or `anchor build`).
Expected: clean compile. The `#[derive(InitSpace)]` on `Vault` now includes the new fields.

- [ ] **Step 5: Commit**

```bash
git add programs/dexter-vault/src/state.rs
git commit -m "feat(vault): V4 struct fields — LockedClaim accounting (Vault +3 u64, session +u64+u32)"
```

---

## Task 2: Freeze a V3-shaped decoder + write the migrate_v3_to_v4 handler

**Files:**
- Create: `programs/dexter-vault/src/instructions/migrate_v3_to_v4.rs`

**The strategy (decode-old → re-encode-new), in full:**
1. Take vault as `AccountInfo` (mut, owner = program). NOT typed (the typed `Account<Vault>` would deserialize against the NEW V4 struct and fail/misread a V3 buffer).
2. Verify discriminator == `Vault::DISCRIMINATOR`, version byte (offset 8) == `VAULT_VERSION_V3`.
3. **Decode the whole account** using a LOCAL frozen `VaultV3` struct (the exact V3 layout, including a local `SessionRegistrationV3`). A 305-byte Some-vault decodes cleanly because it IS V3. This is the key difference from v2→v3: here we CAN safely decode the full old struct.
4. Authority-gate: `decoded.dexter_authority == signer`.
5. **Re-encode as V4**: construct a `Vault` (the real, current/V4 struct) from the decoded V3 values, setting the 5 new fields to 0 (and the 2 session fields to 0 if `active_session` is Some).
6. Resize the account to `8 + Vault::INIT_SPACE` (V4 size), rent top-up via payer.
7. Write `Vault::DISCRIMINATOR` + serialized V4 struct (which now has `version` — set it to `VAULT_VERSION_V4` in the re-encoded struct before serializing).

- [ ] **Step 1: Write the failing test first** (see Task 4 — the mainnet test IS the failing test; this task makes it compile + pass locally-buildable). For TDD ordering, write Task 4's test file first so it exists, then implement here. (Local `cargo build-sbf` is the compile gate; the behavioral test is mainnet, Task 4.)

- [ ] **Step 2: Write the frozen V3 decoder structs**

In `migrate_v3_to_v4.rs`, define LOCAL structs matching the V3 layout EXACTLY (derive these from the current state.rs MINUS the 5 new V4 fields — i.e. the struct as it was at commit before Task 1):
```rust
// Frozen V3 layout — the shape on chain BEFORE this migration. Used only to
// decode old accounts. Must match state.rs as of VAULT_VERSION_V3 exactly.
#[derive(AnchorDeserialize)]
struct SessionRegistrationV3 {
    session_pubkey: [u8; 32],
    max_amount: u64,
    expires_at: i64,
    allowed_counterparty: Pubkey,
    nonce: u32,
    spent: u64,
    current_outstanding: u64,
    max_revolving_capacity: u64,
}

#[derive(AnchorDeserialize)]
struct VaultV3 {
    version: u8,
    bump: u8,
    passkey_pubkey: [u8; 33],
    swig_address: Pubkey,
    cooling_off_seconds: u32,
    pending_voucher_count: u32,
    pending_withdrawal: Option<PendingWithdrawal>,
    identity_claim: [u8; 32],
    dexter_authority: Pubkey,
    active_session: Option<SessionRegistrationV3>,
}
```
(`PendingWithdrawal` is unchanged across V3/V4, so import it from `crate::state`.)

- [ ] **Step 3: Write the accounts context + handler**

Mirror `migrate_v2_to_v3`'s accounts context (vault AccountInfo mut owner=program, dexter_authority Signer, payer Signer, system_program). Handler:
```rust
pub fn handler(ctx: Context<MigrateV3ToV4>, _args: MigrateV3ToV4Args) -> Result<()> {
    let vault_ai = &ctx.accounts.vault;

    // (1) discriminator + version == V3
    let v3: VaultV3 = {
        let data = vault_ai.try_borrow_data()?;
        require!(data.len() >= 9, VaultError::UnsupportedVaultVersion);
        require!(&data[0..8] == Vault::DISCRIMINATOR, VaultError::UnsupportedVaultVersion);
        require!(data[8] == VAULT_VERSION_V3, VaultError::UnsupportedVaultVersion);
        // (2) decode the FULL V3 account — safe: a V3 account matches the V3 struct.
        let mut cursor: &[u8] = &data[8..];
        VaultV3::deserialize(&mut cursor)?
    };

    // (3) authority gate
    require!(
        v3.dexter_authority == ctx.accounts.dexter_authority.key(),
        VaultError::PasskeyVerificationFailed
    );

    // (4) re-encode as V4 with new fields zeroed
    let v4 = Vault {
        version: VAULT_VERSION_V4,
        bump: v3.bump,
        passkey_pubkey: v3.passkey_pubkey,
        swig_address: v3.swig_address,
        cooling_off_seconds: v3.cooling_off_seconds,
        pending_voucher_count: v3.pending_voucher_count,
        pending_withdrawal: v3.pending_withdrawal,
        identity_claim: v3.identity_claim,
        dexter_authority: v3.dexter_authority,
        active_session: v3.active_session.map(|s| SessionRegistration {
            session_pubkey: s.session_pubkey,
            max_amount: s.max_amount,
            expires_at: s.expires_at,
            allowed_counterparty: s.allowed_counterparty,
            nonce: s.nonce,
            spent: s.spent,
            current_outstanding: s.current_outstanding,
            max_revolving_capacity: s.max_revolving_capacity,
            crystallized_cumulative: 0,   // NEW V4, zeroed
            last_locked_sequence: 0,      // NEW V4, zeroed
        }),
        outstanding_locked_amount: 0,     // NEW V4, zeroed
        total_crystallized_amount: 0,     // NEW V4, zeroed
        total_settled_amount: 0,          // NEW V4, zeroed
    };

    // (5) resize to V4 size, rent top-up
    let new_size = 8 + Vault::INIT_SPACE;
    let old_size = vault_ai.data_len();
    if new_size > old_size {
        let rent = Rent::get()?;
        let new_min = rent.minimum_balance(new_size);
        let cur = vault_ai.lamports();
        if new_min > cur {
            anchor_lang::system_program::transfer(
                CpiContext::new(
                    ctx.accounts.system_program.to_account_info(),
                    anchor_lang::system_program::Transfer {
                        from: ctx.accounts.payer.to_account_info(),
                        to: vault_ai.to_account_info(),
                    },
                ),
                new_min - cur,
            )?;
        }
        vault_ai.resize(new_size)?;
    }

    // (6) write discriminator + re-encoded V4 struct
    {
        let mut data = vault_ai.try_borrow_mut_data()?;
        let mut out = Vec::with_capacity(new_size);
        out.extend_from_slice(Vault::DISCRIMINATOR);
        v4.serialize(&mut out)?;
        require!(out.len() <= data.len(), VaultError::UnsupportedVaultVersion);
        data[..out.len()].copy_from_slice(&out);
        // any trailing bytes (if new_size > out.len(), shouldn't happen for exact INIT_SPACE) stay zero
    }

    Ok(())
}
```
(Include `MigrateV3ToV4Args {}` empty-args struct and the `#[derive(Accounts)] MigrateV3ToV4` context, mirroring the v2→v3 file.)

- [ ] **Step 4: Build**

Run: `cd programs/dexter-vault && anchor build 2>&1 | tail -5`. Expected: clean compile, IDL regenerates with `migrate_v3_to_v4`.

- [ ] **Step 5: Commit**

```bash
git add programs/dexter-vault/src/instructions/migrate_v3_to_v4.rs
git commit -m "feat(vault): migrate_v3_to_v4 — decode-V3 / re-encode-V4 (handles Some-session interior growth)"
```

---

## Task 3: Register the instruction + update version gates

**Files:**
- Modify: `programs/dexter-vault/src/instructions/mod.rs`, `programs/dexter-vault/src/lib.rs`

- [ ] **Step 1: mod.rs re-export**

Add `pub mod migrate_v3_to_v4; pub use migrate_v3_to_v4::*;` alongside the existing migrate_v2_to_v3 line.

- [ ] **Step 2: lib.rs handler registration**

Add the `migrate_v3_to_v4` handler entry mirroring `migrate_v2_to_v3`.

- [ ] **Step 3: Version gates**

`initialize_vault` now sets `VAULT_VERSION_V4`. `register_session_key` requires V4 (the enlarged session needs the space — same logic as the V3 gate). All other instructions that currently accept `V3 || V2` should accept `V4 || V3 || V2` (so partially-migrated vaults still work for lock-only/settle paths). Grep for `VAULT_VERSION_V3` across instructions and widen each `require!` accordingly. CRITICAL: do NOT change the meter/settle behavior — only widen the version acceptance.

- [ ] **Step 4: Build**

Run: `anchor build 2>&1 | tail -5`. Expected: clean, program now has 15 instructions (was 14).

- [ ] **Step 5: Commit**

```bash
git add programs/dexter-vault/src/instructions/mod.rs programs/dexter-vault/src/lib.rs
git commit -m "feat(vault): register migrate_v3_to_v4 + widen version gates to V4||V3||V2"
```

---

## Task 4: Mainnet migration proof — Some AND None, read-back-every-field

**Files:**
- Create: `tests/migrate-v3-to-v4.ts`

**This is the load-bearing verification. The migration is correct ONLY if a real Some-session V3 vault migrates to V4 with EVERY pre-existing field bit-for-bit preserved and the 5 new fields = 0.** This mirrors the v2→v3 verification that proved `EVuq1Vpe...` preserved its session.

⚠️ **DEPLOY + MAINNET-WRITE GATE:** This task requires (a) deploying the upgraded program to mainnet and (b) migrating a real on-chain vault. BOTH are mainnet writes reserved for Branch's explicit per-step authorization. The implementer MUST STOP before any `anchor deploy`/`anchor upgrade` and before any migration tx, and report BLOCKED-AWAITING-BRANCH. Do NOT deploy or migrate without Branch's go.

- [ ] **Step 1: Assert the INIT_SPACE math in a test (local, no chain)**

Compute the expected V4 account size and assert against the IDL/struct. For a Some vault: V3 was 305 bytes. V4 adds 12 (session) + 24 (vault) = +36 → 341 bytes. For None: V3 None vaults are 305 too (the None active_session is 1 byte; the 305 came from... verify actual None-vault size on chain first — it may differ). Write a test that fetches a known V3 vault, records its size, and asserts the post-migration size equals `8 + INIT_SPACE`.

- [ ] **Step 2: Write the migration + read-back test (mirrors revolving-meter.ts ceremony for provisioning)**

The test must, against mainnet:
1. Pick a V3 `Some` vault we control the authority for (production master `3SWJTQ4FB...` or provision a fresh V3 Some vault via the registration ceremony, then migrate it).
2. BEFORE migrating: fetch + record every field of the V3 vault (all prefix fields + the full active_session: session_pubkey, max_amount, expires_at, allowed_counterparty, nonce, spent, current_outstanding, max_revolving_capacity).
3. Call `migrate_v3_to_v4`.
4. AFTER: fetch the V4 vault. ASSERT:
   - `version == 4`
   - EVERY recorded prefix field unchanged
   - EVERY recorded active_session field unchanged (this is the bit-for-bit proof the re-encode preserved the session)
   - `crystallized_cumulative == 0`, `last_locked_sequence == 0`
   - `outstanding_locked_amount == 0`, `total_crystallized_amount == 0`, `total_settled_amount == 0`
   - account byte length == expected V4 size
5. Repeat for a `None` vault (provision or pick one): assert version bump, prefix preserved, 3 vault fields = 0, no active_session.

- [ ] **Step 3: STOP — report BLOCKED-AWAITING-BRANCH for deploy + migration**

The implementer reports the test is written and locally type-checks, and STOPS. Branch authorizes: (a) the program deploy, (b) the migration tx on a real vault. Only after Branch's explicit go does the mainnet run proceed.

- [ ] **Step 4: (After Branch's go) Run on mainnet**

```bash
ANCHOR_WALLET=$HOME/.config/solana/dexter-vault/upgrade-authority.json \
ANCHOR_PROVIDER_URL=https://api.mainnet-beta.solana.com \
npx ts-mocha -p ./tsconfig.json -t 600000 tests/migrate-v3-to-v4.ts
```
(sandbox disabled for fetch; tolerate 429 retries.) Expected: both Some and None migrations green, every field asserted.

- [ ] **Step 5: Commit**

```bash
git add tests/migrate-v3-to-v4.ts
git commit -m "test(vault): migrate_v3_to_v4 mainnet proof — Some+None, bit-for-bit field preservation"
```

---

## DISCIPLINE REMINDERS
- **HARD deploy/migration fence:** Tasks 1-3 + Task 4 Steps 1-2 are build/type-check only — NO chain writes. Task 4 Steps 3-4 require Branch's explicit per-step go for the program deploy AND the migration tx. STOP and report BLOCKED-AWAITING-BRANCH at Step 3.
- **The frozen VaultV3 decoder MUST match state.rs as of V3 exactly** — derive it from the current struct minus the 5 new fields. Any drift silently corrupts the decode. Verify field-by-field against the committed V3 state.rs.
- **Do NOT alter meter/settle behavior** — version gates widen acceptance only; `current_outstanding`/`spent`/`max_revolving_capacity` semantics are untouched (seam spec §5).
- Tests run on MAINNET (secp256r1 mainnet-only). Node fetch needs sandbox disabled.
- Commit per task. Do NOT push (Branch's call).
- This plan MERGES with the LockedClaim instruction plan into one Phase 1 file. The 5 struct fields added here MUST match the LockedClaim plan's field list exactly (both derive from the signed seam spec). Coordinate the merge so the fields are added once, not twice.

## SELF-REVIEW NOTES
- **Why decode/re-encode, not append-zero-fill:** the Some-case has an interior growth point (SessionRegistration's +12 sits inside `active_session`, which is followed by the +24 Vault tail). Zero-filling the tail can't place interior bytes. Decode-then-re-encode is offset-proof. (Verified by reasoning through the V4 byte order against the 6 Some-vaults on chain.)
- **Why decode is safe here but wasn't in v2→v3:** v2→v3's chicken-and-egg was that V2 accounts were SHORTER than the running struct, so a typed full-decode over-ran. V3 accounts are NOT shorter than the V3 struct — they match it — so a frozen-V3-struct decode succeeds. The frozen local struct (not the live `Account<Vault>`) is what makes it safe.
- **Population:** 8 V3 vaults (6 Some, 2 None), all 305B. Real ones share the production master (migratable); throwaway-authority test vaults may be unmigratable junk (acceptable).
- **The 5 fields are shared with the LockedClaim plan** — this is flagged for the merge so they're not double-declared.
