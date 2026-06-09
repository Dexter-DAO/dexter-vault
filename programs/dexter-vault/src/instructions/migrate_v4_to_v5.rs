use anchor_lang::prelude::*;
use anchor_lang::Discriminator;

use crate::state::*;

/// Migrate a V4 vault account to the V5 (credit-accounting) layout.
///
/// # Why decode/re-encode, NOT append-zero-fill
///
/// V5 appends FOUR fields to the END of `Vault` (`borrowed: u64`,
/// `standby_backer: Option<Pubkey>`, `standby_cap: u64`,
/// `borrow_recovery_at: Option<i64>`), AFTER `total_settled_amount`.
/// `SessionRegistration` is UNCHANGED V4->V5. Because the additions are
/// tail-only and there is NO interior growth (unlike V3->V4, where the session
/// grew +12 bytes in the MIDDLE of a Some-session buffer), a tail-zero-fill
/// could in principle have worked here.
///
/// We deliberately use decode/re-encode anyway, for two reasons:
///   1. It matches the proven sibling (`migrate_v3_to_v4`) byte-for-byte in
///      strategy, so there is one auditable migration shape, not two.
///   2. The current `Vault` struct is LARGER than a V4 buffer, so it cannot be
///      auto-deserialized against a V4-sized account (Anchor would over-run).
///      Taking the account as an `AccountInfo` and decoding it through a frozen,
///      V4-shaped struct sidesteps that entirely. Borsh computes every offset
///      from the struct layout, so we never hand-compute an offset.
///
/// # The strategy: decode the old account as a frozen V4 struct, re-encode as V5
///
/// We deserialize the on-chain account with a LOCAL, frozen V4-shaped struct
/// (`VaultV4` = the current `Vault` MINUS the 4 V5 fields), then re-serialize it
/// as the current (V5) `Vault` with the 4 new fields set to neutral defaults.
///
/// # Why the decode is SAFE
///
/// A V4 account MATCHES the frozen `VaultV4` struct EXACTLY (it was written under
/// that very layout), so decoding it against `VaultV4` cannot over-run — every
/// byte the decoder reads is present. (Ground truth, mainnet 2026-06-07: all 50
/// V4 vaults are exactly 341 bytes = 8-byte discriminator + V4 `INIT_SPACE`, and
/// every one carries version byte == 4. The decoder reads a strict prefix of that
/// 341-byte buffer, so it cannot over-run.) We still take the vault as a
/// `/// CHECK:`'d `AccountInfo` rather than `Account<'info, Vault>` so Anchor does
/// NOT auto-deserialize it against the LARGER current (V5) struct on entry — that
/// WOULD over-run the still-V4-sized 341-byte buffer.
///
/// # Legacy-vault note: the 4 new credit fields migrate to neutral defaults
///
/// A migrated V4 vault gets `borrowed = 0`, `standby_backer = None`,
/// `standby_cap = 0`, `borrow_recovery_at = None`. That is correct: no credit
/// relationship existed pre-migration — there was no financier, nothing was
/// fronted, and there is no recovery deadline. `open_standby` will later set
/// `standby_backer` / `standby_cap`; `draw_credit` will set `borrowed` /
/// `borrow_recovery_at`.
///
/// # Authority gating
///
/// Mirrors `migrate_v3_to_v4` and the privileged-op model (`settle_voucher`,
/// `rotate_dexter_authority`): the vault's recorded `dexter_authority` must sign.
/// We read it from the decoded V4 struct (not a hand-rolled prefix walk — the
/// full decode is safe here) and compare to the signer. `payer` funds the rent
/// for the extra bytes so the enlarged account stays rent-exempt.
#[derive(Accounts)]
pub struct MigrateV4ToV5<'info> {
    /// CHECK: This is a V4 `Vault` account, still serialized under the V4 layout.
    /// We deliberately do NOT load it as `Account<'info, Vault>`, because Anchor
    /// would auto-deserialize it against the CURRENT (larger, V5) struct and
    /// over-run the still-V4-sized buffer. We validate it by hand in the handler:
    /// discriminator match, version == 4, and `dexter_authority` ownership. We
    /// also require it be owned by this program before touching its bytes.
    #[account(mut, owner = crate::ID)]
    pub vault: AccountInfo<'info>,

    /// Must equal the vault's recorded `dexter_authority`. Same authority that
    /// gates `settle_voucher` / `rotate_dexter_authority`. Validated by hand
    /// against the decoded V4 struct (no `has_one`, since the vault is untyped
    /// here).
    pub dexter_authority: Signer<'info>,

    /// Funds the rent for the extra bytes the realloc adds. A separate signer so
    /// the authority key need not hold lamports.
    #[account(mut)]
    pub payer: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(AnchorSerialize, AnchorDeserialize)]
pub struct MigrateV4ToV5Args {}

/// # DANGER — keep in lockstep with state.rs (frozen-snapshot drift)
///
/// `VaultV4` below is a HAND-FROZEN snapshot of the V4 on-chain layout. It exists
/// ONLY to decode pre-V5 on-chain bytes; it is never written. It is NOT derived
/// from state.rs — it is a fully independent struct that happens to mirror the
/// pre-V5 field order and types by hand.
///
/// If ANY pre-V5 field in state.rs's `Vault` is reordered, retyped, or has a
/// field inserted BEFORE the V5 additions, this frozen struct MUST be updated in
/// lockstep. The failure mode is SILENT: there is NO compile error if it drifts,
/// because this is an independent struct. A drifted decoder reads the wrong bytes
/// at the wrong offsets and CORRUPTS live vault accounts on migration.
///
/// Safe invariant:
///   * `VaultV4` == current `Vault` MINUS the 4 V5 fields (`borrowed`,
///     `standby_backer`, `standby_cap`, `borrow_recovery_at`).
///   * `SessionRegistration` is UNCHANGED V4->V5, so the frozen decoder REUSES
///     the canonical `crate::state::SessionRegistration` — there is NO frozen
///     session copy (contrast `migrate_v3_to_v4`, where the session grew and
///     required a frozen `SessionRegistrationV3`). `Option<SessionRegistration>`
///     decodes a V4 vault's session correctly because no session field changed.
/// Only the V5 *additions* — which are appended at the END of `Vault` — may
/// differ between this frozen snapshot and state.rs. Every pre-V5 field must
/// match state.rs byte-for-byte, in order and type.
///
/// `PendingWithdrawal` is unchanged across V4/V5, so we reuse the canonical
/// `crate::state::PendingWithdrawal`. Used ONLY to decode pre-V5 on-chain bytes;
/// never written.
#[derive(AnchorDeserialize)]
struct VaultV4 {
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
    // SessionRegistration is UNCHANGED V4->V5; reuse the canonical struct.
    active_session: Option<SessionRegistration>,
    outstanding_locked_amount: u64,
    total_crystallized_amount: u64,
    total_settled_amount: u64,
}

/// # DANGER — frozen V5 WRITER snapshot (immune to V6 reshape)
///
/// `VaultV5Frozen` is a HAND-FROZEN snapshot of the V5 on-chain layout used ONLY
/// to RE-ENCODE this migration's output. This migration runs on MAINNET and MUST
/// emit a byte-identical V5 layout regardless of how the live `Vault` struct
/// changes in later versions (V6 dropped `active_session` for
/// `live_session_count`). We can no longer build a `Vault { active_session, ... }`
/// literal, so we write through this frozen V5 shape instead.
///
/// Safe invariant: `VaultV5Frozen` MUST match the PRE-V6 `Vault` layout EXACTLY
/// (the struct at commit 7b5139c^, before the V6 reshape), in field order and
/// type: the V4 shape (`active_session` + the three LockedClaim odometers) PLUS
/// the four V5 credit fields (`borrowed`, `standby_backer`, `standby_cap`,
/// `borrow_recovery_at`). `SessionRegistration` and `PendingWithdrawal` are
/// unchanged at V5, so the frozen writer reuses the canonical `crate::state::*`
/// structs.
#[derive(AnchorSerialize, AnchorDeserialize, InitSpace)]
struct VaultV5Frozen {
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
    borrowed: u64,
    standby_backer: Option<Pubkey>,
    standby_cap: u64,
    borrow_recovery_at: Option<i64>,
}

pub fn handler(ctx: Context<MigrateV4ToV5>, _args: MigrateV4ToV5Args) -> Result<()> {
    let vault_ai = &ctx.accounts.vault;

    // ---- (1) decode the account as a frozen V4 struct ---------------------
    // Verify discriminator + version == 4, then deserialize the WHOLE account
    // against `VaultV4` (safe: a V4 account matches `VaultV4` exactly, so the
    // decoder never over-runs). We start the cursor at offset 8, after the
    // 8-byte Anchor discriminator.
    let v4: VaultV4 = {
        let data = vault_ai.try_borrow_data()?;
        require!(data.len() >= 9, VaultError::UnsupportedVaultVersion);
        require!(
            &data[0..8] == Vault::DISCRIMINATOR,
            VaultError::UnsupportedVaultVersion
        );
        require!(data[8] == VAULT_VERSION_V4, VaultError::UnsupportedVaultVersion);
        let mut cursor: &[u8] = &data[8..];
        VaultV4::deserialize(&mut cursor)?
    }; // drop the data borrow before realloc takes a mut borrow

    // ---- (2) authority-gate -----------------------------------------------
    require!(
        v4.dexter_authority == ctx.accounts.dexter_authority.key(),
        VaultError::PasskeyVerificationFailed
    );

    // ---- (3) re-encode as the frozen V5 Vault, new fields neutral --------
    // We write through `VaultV5Frozen` (not the live `Vault`) so this migration
    // emits a byte-identical V5 layout even after the live struct reshapes in
    // later versions (V6 dropped `active_session` for `live_session_count`).
    let v5 = VaultV5Frozen {
        version: VAULT_VERSION_V5,
        bump: v4.bump,
        passkey_pubkey: v4.passkey_pubkey,
        swig_address: v4.swig_address,
        cooling_off_seconds: v4.cooling_off_seconds,
        pending_voucher_count: v4.pending_voucher_count,
        pending_withdrawal: v4.pending_withdrawal,
        identity_claim: v4.identity_claim,
        dexter_authority: v4.dexter_authority,
        // SessionRegistration is unchanged V4->V5, so the decoded value is the
        // exact current shape — carry it through verbatim.
        active_session: v4.active_session,
        outstanding_locked_amount: v4.outstanding_locked_amount,
        total_crystallized_amount: v4.total_crystallized_amount,
        total_settled_amount: v4.total_settled_amount,
        // V5 credit accounting: no credit relationship existed pre-migration, so
        // these are neutral (see module doc, legacy-vault note).
        borrowed: 0,
        standby_backer: None,
        standby_cap: 0,
        borrow_recovery_at: None,
    };

    // ---- (4) realloc to the V5 size, topping up rent ----------------------
    // new_size = 8 (discriminator) + V5 INIT_SPACE. The grown region is the 4
    // trailing V5 fields, well under MAX_PERMITTED_DATA_INCREASE. `resize`
    // zero-extends the grown region; step (5) then overwrites the whole buffer
    // with the V5 encoding, so the zero-extension is just to make room.
    let new_size = 8 + VaultV5Frozen::INIT_SPACE;
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

    // ---- (5) write the V5 encoding ----------------------------------------
    // Serialize discriminator + V5 body into a scratch buffer, then copy over the
    // account data. After resize the account is >= new_size, so `out` fits.
    {
        let mut data = vault_ai.try_borrow_mut_data()?;
        let mut out = Vec::with_capacity(new_size);
        out.extend_from_slice(Vault::DISCRIMINATOR);
        v5.serialize(&mut out)?;
        require!(out.len() <= data.len(), VaultError::UnsupportedVaultVersion);
        data[..out.len()].copy_from_slice(&out);
    }

    Ok(())
}
