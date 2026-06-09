use anchor_lang::prelude::*;
use anchor_lang::Discriminator;

use crate::state::*;

/// Migrate a V3 vault account to the V4 (LockedClaim-accounting) layout.
///
/// # Why decode/re-encode, NOT append-zero-fill
///
/// `migrate_v2_to_v3` could realloc + zero-fill the trailing bytes because both
/// new fields were the LAST two fields of the LAST field (`SessionRegistration`,
/// inside `Vault::active_session`). Growing the account and zero-extending the
/// tail placed `current_outstanding = 0` then `max_revolving_capacity = 0` at
/// precisely the offsets the V3 reader expects. No byte shuffle was needed.
///
/// V4 CANNOT do that. V4 has TWO growth points, and one of them is INTERIOR for
/// Some-session vaults:
///   * `SessionRegistration` grows +12 bytes (`crystallized_cumulative: u64` +
///     `last_locked_sequence: u32`) INSIDE the `Vault::active_session` Option;
///   * `Vault` grows +24 bytes (`outstanding_locked_amount`,
///     `total_crystallized_amount`, `total_settled_amount`) AFTER
///     `active_session`.
/// For a `active_session = Some(..)` vault, the session's 12 new bytes land in
/// the MIDDLE of the buffer (between the old end-of-session and the new vault
/// tail fields). A tail-only zero-fill would write all 36 grown bytes at the END
/// — misplacing the interior 12 and corrupting the decode of every field after
/// the session. So we cannot append; we must rebuild the buffer.
///
/// # The strategy: decode the old account as a frozen V3 struct, re-encode as V4
///
/// We deserialize the on-chain account with a LOCAL, frozen V3-shaped struct
/// (the current `Vault` / `SessionRegistration` MINUS the 5 V4 fields), then
/// re-serialize it as the current (V4) `Vault` with the 5 new fields set to 0.
/// Borsh computes every offset from the struct layout — we never hand-compute an
/// interior offset, so the Some-session interior growth is handled correctly and
/// automatically. The None-session case re-encodes a single Option-discriminant
/// byte for `active_session` and the three new vault u64s = 0.
///
/// # Why the decode is SAFE (no chicken-and-egg, unlike v2->v3)
///
/// The v2->v3 migration could NOT load the account as `Account<'info, Vault>`
/// because Some-session V2 vaults were SHORTER than the then-current (V3) struct,
/// so auto-deserialize over-ran the buffer. Here the asymmetry is reversed: a V3
/// account MATCHES the frozen `VaultV3` struct EXACTLY (it was written under that
/// very layout), so decoding it against `VaultV3` cannot over-run — every byte
/// the decoder reads is present. (Ground truth: all 8 mainnet V3 vaults are 305
/// bytes, both the 6 Some and the 2 None.) We still take the vault as a
/// `/// CHECK:`'d `AccountInfo` rather than `Account<'info, Vault>` so Anchor
/// does NOT auto-deserialize it against the LARGER current (V4) struct on entry —
/// that WOULD over-run the still-V3-sized buffer.
///
/// # Legacy-session note: the 2 new session fields migrate to 0
///
/// A migrated Some-session vault gets `crystallized_cumulative = 0` and
/// `last_locked_sequence = 0` on its existing (legacy) session. That is correct:
/// the legacy session has never locked a voucher into a claim, so its
/// lock-terminal odometers are genuinely 0. The XOR frontier
/// `max(spent, crystallized_cumulative)` therefore reduces to `spent`, exactly
/// as a never-locked session should behave. Likewise the three new vault-scope
/// odometers (`outstanding_locked_amount`, `total_crystallized_amount`,
/// `total_settled_amount`) are 0 because no LockedClaim accounting has occurred.
///
/// # Authority gating
///
/// Mirrors `migrate_v2_to_v3` and the privileged-op model (`settle_voucher`,
/// `rotate_dexter_authority`): the vault's recorded `dexter_authority` must sign.
/// We read it from the decoded V3 struct (not a hand-rolled prefix walk — the
/// full decode is safe here) and compare to the signer. `payer` funds the rent
/// for the 36 extra bytes so the enlarged account stays rent-exempt.
#[derive(Accounts)]
pub struct MigrateV3ToV4<'info> {
    /// CHECK: This is a V3 `Vault` account, still serialized under the V3 layout
    /// (305 bytes on mainnet). We deliberately do NOT load it as
    /// `Account<'info, Vault>`, because Anchor would auto-deserialize it against
    /// the CURRENT (larger, V4) struct and over-run the still-V3-sized buffer. We
    /// validate it by hand in the handler: discriminator match, version == 3, and
    /// `dexter_authority` ownership. We also require it be owned by this program
    /// before touching its bytes.
    #[account(mut, owner = crate::ID)]
    pub vault: AccountInfo<'info>,

    /// Must equal the vault's recorded `dexter_authority`. Same authority that
    /// gates `settle_voucher` / `rotate_dexter_authority`. Validated by hand
    /// against the decoded V3 struct (no `has_one`, since the vault is untyped
    /// here).
    pub dexter_authority: Signer<'info>,

    /// Funds the rent for the 36 extra bytes the realloc adds. A separate signer
    /// so the authority key need not hold lamports.
    #[account(mut)]
    pub payer: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(AnchorSerialize, AnchorDeserialize)]
pub struct MigrateV3ToV4Args {}

/// # DANGER — keep in lockstep with state.rs (frozen-snapshot drift)
///
/// `SessionRegistrationV3` and `VaultV3` below are HAND-FROZEN snapshots of the
/// V3 on-chain layout. They exist ONLY to decode pre-V4 on-chain bytes; they are
/// never written. They are NOT derived from state.rs — they are fully independent
/// structs that happen to mirror the pre-V4 field order and types by hand.
///
/// If ANY pre-V4 field in state.rs's `Vault` or `SessionRegistration` is
/// reordered, retyped, or has a field inserted BEFORE the V4 additions, these
/// frozen structs MUST be updated in lockstep. The failure mode is SILENT: there
/// is NO compile error if they drift, because these are independent structs.
/// A drifted decoder reads the wrong bytes at the wrong offsets and CORRUPTS live
/// vault accounts on migration.
///
/// Safe invariant:
///   * `VaultV3` == current `Vault` MINUS the 3 V4 fields
///     (`outstanding_locked_amount`, `total_crystallized_amount`,
///     `total_settled_amount`).
///   * `SessionRegistrationV3` == current `SessionRegistration` MINUS the 2 V4
///     fields (`crystallized_cumulative`, `last_locked_sequence`).
/// Only the V4 *additions* — which are appended at the END of each state.rs
/// struct — may differ between these frozen snapshots and state.rs. Every
/// pre-V4 field must match state.rs byte-for-byte, in order and type.
///
/// Frozen V3 layout of `SessionRegistration` = current struct MINUS the two V4
/// fields (`crystallized_cumulative`, `last_locked_sequence`). Used ONLY to
/// decode pre-V4 on-chain bytes; never written.
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

/// Frozen V3 layout of `Vault` = current struct MINUS the three V4 fields
/// (`outstanding_locked_amount`, `total_crystallized_amount`,
/// `total_settled_amount`) and with `active_session` carrying the V3-shaped
/// session. `PendingWithdrawal` is unchanged across V3/V4, so we reuse the
/// canonical `crate::state::PendingWithdrawal`. Used ONLY to decode pre-V4
/// on-chain bytes; never written.
#[derive(AnchorDeserialize)]
struct VaultV3 {
    // Decoded for layout fidelity but unread: the version gate happens on the
    // raw `data[8]` byte before this struct is deserialized.
    #[allow(dead_code)]
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

/// # DANGER — frozen V4 WRITER snapshot (immune to V6 reshape)
///
/// `VaultV4Frozen` is a HAND-FROZEN snapshot of the V4 on-chain layout used ONLY
/// to RE-ENCODE this migration's output. This migration runs on MAINNET and MUST
/// emit a byte-identical V4 layout regardless of how the live `Vault` struct
/// changes in later versions (V5, V6, ...). The live `Vault` struct no longer
/// carries `active_session` (V6 replaced it with `live_session_count`), so we can
/// no longer build a `Vault { active_session, ... }` literal here. We write
/// through this frozen V4 shape instead.
///
/// Safe invariant: `VaultV4Frozen` MUST match the V4 on-chain layout EXACTLY, in
/// field order and type. It is the same field set as `migrate_v4_to_v5`'s frozen
/// `VaultV4` READER (both describe the identical V4 layout): the pre-V5 `Vault`
/// shape — `active_session` plus the three V4 LockedClaim odometers, but NONE of
/// the V5 credit fields (`borrowed`, `standby_backer`, `standby_cap`,
/// `borrow_recovery_at`).
///
/// `SessionRegistration` and `PendingWithdrawal` are unchanged at V4, so the
/// frozen writer reuses the canonical `crate::state::*` structs.
#[derive(AnchorSerialize, AnchorDeserialize, InitSpace)]
struct VaultV4Frozen {
    version: u8,
    bump: u8,
    passkey_pubkey: [u8; 33],
    swig_address: Pubkey,
    cooling_off_seconds: u32,
    pending_voucher_count: u32,
    pending_withdrawal: Option<PendingWithdrawal>,
    identity_claim: [u8; 32],
    dexter_authority: Pubkey,
    active_session: Option<SessionRegistration>,
    outstanding_locked_amount: u64,
    total_crystallized_amount: u64,
    total_settled_amount: u64,
}

pub fn handler(ctx: Context<MigrateV3ToV4>, _args: MigrateV3ToV4Args) -> Result<()> {
    let vault_ai = &ctx.accounts.vault;

    // ---- (1) decode the account as a frozen V3 struct ---------------------
    // Verify discriminator + version == 3, then deserialize the WHOLE account
    // against `VaultV3` (safe: a V3 account matches `VaultV3` exactly, so the
    // decoder never over-runs). We start the cursor at offset 8, after the
    // 8-byte Anchor discriminator.
    let v3: VaultV3 = {
        let data = vault_ai.try_borrow_data()?;
        require!(data.len() >= 9, VaultError::UnsupportedVaultVersion);
        require!(
            &data[0..8] == Vault::DISCRIMINATOR,
            VaultError::UnsupportedVaultVersion
        );
        require!(data[8] == VAULT_VERSION_V3, VaultError::UnsupportedVaultVersion);
        let mut cursor: &[u8] = &data[8..];
        VaultV3::deserialize(&mut cursor)?
    }; // drop the data borrow before realloc takes a mut borrow

    // ---- (2) authority-gate -----------------------------------------------
    require!(
        v3.dexter_authority == ctx.accounts.dexter_authority.key(),
        VaultError::PasskeyVerificationFailed
    );

    // ---- (3) re-encode as the frozen V4 Vault, new fields = 0 -------------
    // We write through `VaultV4Frozen` (not the live `Vault`) so this migration
    // emits a byte-identical V4 layout even after the live struct reshapes in
    // later versions (V6 dropped `active_session`). This migration emits a V4
    // vault with NO V5 credit fields — those are appended only by the V4->V5 path.
    let v4 = VaultV4Frozen {
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
            // V4 session fields: a legacy session has never locked, so these are
            // genuinely 0 (see module doc, legacy-session note).
            crystallized_cumulative: 0,
            last_locked_sequence: 0,
        }),
        // V4 vault-scope LockedClaim odometers: no lock accounting yet -> 0.
        outstanding_locked_amount: 0,
        total_crystallized_amount: 0,
        total_settled_amount: 0,
    };

    // ---- (4) realloc to the V4 size, topping up rent ----------------------
    // new_size = 8 (discriminator) + V4 INIT_SPACE. The grown region is +36
    // bytes for a Some-session vault (12 interior session + 24 trailing vault),
    // well under MAX_PERMITTED_DATA_INCREASE. `resize` zero-extends the grown
    // region; step (5) then overwrites the whole buffer with the V4 encoding, so
    // the zero-extension is just to make room.
    let new_size = 8 + VaultV4Frozen::INIT_SPACE;
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

    // ---- (5) write the V4 encoding ----------------------------------------
    // Serialize discriminator + V4 body into a scratch buffer, then copy over the
    // account data. After resize the account is >= new_size, so `out` fits.
    {
        let mut data = vault_ai.try_borrow_mut_data()?;
        let mut out = Vec::with_capacity(new_size);
        out.extend_from_slice(Vault::DISCRIMINATOR);
        v4.serialize(&mut out)?;
        require!(out.len() <= data.len(), VaultError::UnsupportedVaultVersion);
        data[..out.len()].copy_from_slice(&out);
    }

    Ok(())
}
