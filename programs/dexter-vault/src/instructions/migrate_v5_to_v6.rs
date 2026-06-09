use anchor_lang::prelude::*;
use anchor_lang::Discriminator;

use crate::state::*;

/// Migrate a V5 vault account to the V6 (multi-session) layout — NO-SESSION path.
///
/// # What V6 changes
///
/// V6 moves sessions OUT of the `Vault` struct into per-counterparty
/// `SessionAccount` PDAs. The `Vault` loses `active_session: Option<SessionRegistration>`
/// and gains `live_session_count: u8`. The Option<SessionRegistration> was an
/// inline, variable-length field; replacing it with a single `u8` SHRINKS the
/// account. So unlike `migrate_v4_to_v5` (which GREW the account and topped up
/// rent), this migration shrinks the account and REFUNDS the freed rent to the
/// payer.
///
/// # Why decode/re-encode, NOT in-place edit
///
/// Same reasoning as the sibling migrations: we cannot auto-deserialize a still-V5
/// account against the current (V6) `Vault` struct — the field shapes differ
/// (the Option became a u8 in the MIDDLE of the struct). We take the vault as a
/// `/// CHECK:`'d `AccountInfo`, decode it through a frozen V5-shaped struct, then
/// re-encode it as the current V6 `Vault`. Borsh computes every offset from the
/// struct layout, so we never hand-compute an offset.
///
/// # This is the NO-SESSION path ONLY
///
/// All 50 mainnet vaults today have NO live `active_session`, so this path covers
/// every live vault. A vault that DOES carry a LIVE (unexpired) session is REJECTED
/// here — it must use the with-session variant (Task 3b), which migrates the live
/// session out into a `SessionAccount` PDA. An EXPIRED session carries no live
/// exposure, so it is safe to drop on the floor (we simply do not carry it forward,
/// and start V6 with `live_session_count = 0`).
///
/// # Authority gating
///
/// Mirrors the sibling migrations and the privileged-op model: the vault's recorded
/// `dexter_authority` must sign. We read it from the decoded V5 struct and compare
/// to the signer. `payer` RECEIVES the refunded rent (the account shrinks).
#[derive(Accounts)]
pub struct MigrateV5ToV6<'info> {
    /// CHECK: decoded manually through the frozen VaultV5Reader; NOT auto-
    /// deserialized as the current (V6) Vault. owner-gated to this program.
    #[account(mut, owner = crate::ID)]
    pub vault: AccountInfo<'info>,
    /// Authority gate — must equal the decoded vault.dexter_authority.
    pub dexter_authority: Signer<'info>,
    /// Receives the refunded rent (the Vault shrinks).
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(AnchorSerialize, AnchorDeserialize)]
pub struct MigrateV5ToV6Args {}

/// # DANGER — frozen V5 READER snapshot (immune to V6 reshape)
///
/// `VaultV5Reader` is a HAND-FROZEN snapshot of the PRE-V6 (`V5`) on-chain layout,
/// used ONLY to DECODE the existing on-chain bytes; it is never written. It is NOT
/// derived from state.rs — it is a fully independent struct that mirrors the pre-V6
/// `Vault` field order and types by hand.
///
/// Safe invariant: `VaultV5Reader` MUST match `migrate_v4_to_v5::VaultV5Frozen`
/// (the V5 WRITER snapshot) field-for-field, in order and type — both describe the
/// same V5 layout, one for writing it (the V4->V5 output) and one for reading it
/// (this migration's input). It is the V4 shape (`active_session` + the three
/// LockedClaim odometers) PLUS the four V5 credit fields. `SessionRegistration` and
/// `PendingWithdrawal` are unchanged at V5, so the frozen reader reuses the
/// canonical `crate::state::*` structs.
///
/// If this struct drifts from the true V5 layout, the failure is SILENT (no compile
/// error — it is independent) and CORRUPTS live vault accounts on migration.
#[derive(AnchorDeserialize)]
struct VaultV5Reader {
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
    // SessionRegistration is the canonical struct (unchanged at V5).
    active_session: Option<SessionRegistration>,
    outstanding_locked_amount: u64,
    total_crystallized_amount: u64,
    total_settled_amount: u64,
    borrowed: u64,
    standby_backer: Option<Pubkey>,
    standby_cap: u64,
    borrow_recovery_at: Option<i64>,
}

pub fn handler(ctx: Context<MigrateV5ToV6>, _args: MigrateV5ToV6Args) -> Result<()> {
    let vault_ai = &ctx.accounts.vault;

    // ---- (1) decode the account as a frozen V5 struct ---------------------
    // Verify discriminator + version == 5, then deserialize the WHOLE account
    // against `VaultV5Reader` (safe: a V5 account matches it exactly, so the
    // decoder never over-runs). Cursor starts at offset 8, after the discriminator.
    let v5: VaultV5Reader = {
        let data = vault_ai.try_borrow_data()?;
        require!(data.len() >= 9, VaultError::UnsupportedVaultVersion);
        require!(
            &data[0..8] == Vault::DISCRIMINATOR,
            VaultError::UnsupportedVaultVersion
        );
        require!(data[8] == VAULT_VERSION_V5, VaultError::UnsupportedVaultVersion);
        let mut cursor: &[u8] = &data[8..];
        VaultV5Reader::deserialize(&mut cursor)?
    }; // drop the data borrow before resize takes a mut borrow

    // ---- (2) authority-gate -----------------------------------------------
    require!(
        v5.dexter_authority == ctx.accounts.dexter_authority.key(),
        VaultError::PasskeyVerificationFailed
    );

    // ---- (3) NO-SESSION path only -----------------------------------------
    // Reject a vault carrying a LIVE (unexpired) session — that must use the
    // with-session variant (Task 3b). An EXPIRED session carried no live exposure
    // and is dropped (not carried forward; V6 starts at live_session_count = 0).
    let now = Clock::get()?.unix_timestamp;
    if let Some(ref s) = v5.active_session {
        require!(s.expires_at <= now, VaultError::SessionAlreadyActive);
    }

    // ---- (4) re-encode as the current V6 Vault ----------------------------
    // active_session GONE; live_session_count = 0 (no live sessions on this path).
    let v6 = Vault {
        version: VAULT_VERSION_V6,
        bump: v5.bump,
        passkey_pubkey: v5.passkey_pubkey,
        swig_address: v5.swig_address,
        cooling_off_seconds: v5.cooling_off_seconds,
        pending_voucher_count: v5.pending_voucher_count,
        pending_withdrawal: v5.pending_withdrawal,
        identity_claim: v5.identity_claim,
        dexter_authority: v5.dexter_authority,
        live_session_count: 0,
        outstanding_locked_amount: v5.outstanding_locked_amount,
        total_crystallized_amount: v5.total_crystallized_amount,
        total_settled_amount: v5.total_settled_amount,
        borrowed: v5.borrowed,
        standby_backer: v5.standby_backer,
        standby_cap: v5.standby_cap,
        borrow_recovery_at: v5.borrow_recovery_at,
    };

    // ---- (5) write the V6 encoding, shrink the account, refund freed rent --
    // The V6 layout is fixed-size: new_size = 8 (discriminator) + Vault::INIT_SPACE.
    // It is SMALLER than the V5 buffer (the variable Option<SessionRegistration>
    // became a u8). Mirror migrate_v4_to_v5's serialize idiom, but invert the rent
    // direction: after shrinking we REFUND the now-excess lamports to the payer,
    // keeping the account rent-exempt at the new smaller size.
    let new_size = 8 + Vault::INIT_SPACE;

    // Serialize discriminator + V6 body, then copy into the (still V5-sized, i.e.
    // larger) buffer. We write BEFORE resize so `out` always fits.
    {
        let mut data = vault_ai.try_borrow_mut_data()?;
        let mut out = Vec::with_capacity(new_size);
        out.extend_from_slice(Vault::DISCRIMINATOR);
        v6.serialize(&mut out)?;
        // `Vault::INIT_SPACE` is the MAX (Option<T> counts as 1 + size_of::<T>),
        // but Borsh serializes a `None` option as a SINGLE 0x00 byte. A real vault
        // has None pending_withdrawal / standby_backer / borrow_recovery_at, so the
        // encoding is SHORTER than new_size. (An earlier `== new_size` assertion here
        // was the bug: it rejected every None-bearing vault.) Zero-PAD to exactly
        // new_size so the post-resize tail is clean Borsh padding, never stale V5
        // bytes — these trailing zeros deserialize as the `None` option discriminants.
        require!(out.len() <= new_size, VaultError::UnsupportedVaultVersion);
        out.resize(new_size, 0);
        require!(out.len() <= data.len(), VaultError::UnsupportedVaultVersion);
        data[..out.len()].copy_from_slice(&out);
    } // drop the data borrow before resize

    // Shrink the account to the V6 size (out was padded to new_size, so the copied
    // region IS the full V6 layout; resize just trims the leftover V5 tail).
    vault_ai.resize(new_size)?;

    // Refund the lamports freed by shrinking: anything above the rent-exempt
    // minimum for the NEW (smaller) size goes back to the payer. Keep the account
    // rent-exempt at new_size.
    let rent = Rent::get()?;
    let new_min = rent.minimum_balance(new_size);
    let cur = vault_ai.lamports();
    if cur > new_min {
        let refund = cur - new_min;
        // No aliasing: `payer` is a Signer and the vault is a program-owned PDA,
        // so a caller cannot pass the vault as `payer` (a PDA cannot sign). The
        // two lamport borrows are distinct accounts, sequenced, no double-borrow.
        **vault_ai.try_borrow_mut_lamports()? -= refund;
        **ctx.accounts.payer.to_account_info().try_borrow_mut_lamports()? += refund;
    }

    Ok(())
}

// =============================================================================
// Task 3b — WITH-SESSION path: migrate a V5 vault carrying a LIVE active_session
// into V6, carrying that live session OUT into a brand-new SessionAccount PDA.
// =============================================================================

#[derive(AnchorSerialize, AnchorDeserialize)]
pub struct MigrateV5ToV6WithSessionArgs {
    /// The allowed_counterparty of the live active_session being carried. The
    /// handler asserts this equals the decoded active_session.allowed_counterparty,
    /// so the caller cannot redirect the created session PDA to another counterparty.
    pub live_counterparty: Pubkey,
}

/// WITH-SESSION migration accounts.
///
/// Rent dynamics differ from the no-session path: this BOTH shrinks the vault
/// (same Option<SessionRegistration> -> u8 shrink, refunded to `payer`) AND
/// creates a new `SessionAccount` PDA (its rent funded by `payer` via `init`).
/// Net: `payer` funds the session PDA and receives the vault's freed rent.
/// NOTE: `init` runs during account validation, BEFORE the handler body, so
/// `payer` must independently afford the session-PDA rent — the later vault
/// refund cannot back-fill it (init fails first if `payer` is short).
///
/// The session PDA seed `[SESSION_SEED, vault, live_counterparty]` is derived
/// from accounts/args BEFORE the handler decodes the vault — the counterparty
/// lives INSIDE the not-yet-decoded active_session, so it must arrive via args.
/// The handler then asserts the decoded active_session.allowed_counterparty ==
/// args.live_counterparty, closing the redirect gap.
#[derive(Accounts)]
#[instruction(args: MigrateV5ToV6WithSessionArgs)]
pub struct MigrateV5ToV6WithSession<'info> {
    /// CHECK: decoded manually via the frozen VaultV5Reader; owner-gated.
    #[account(mut, owner = crate::ID)]
    pub vault: AccountInfo<'info>,
    /// Authority gate — must equal the decoded vault.dexter_authority.
    pub dexter_authority: Signer<'info>,
    /// The new session PDA, created here to hold the carried live session.
    #[account(
        init,
        payer = payer,
        space = 8 + SessionAccount::INIT_SPACE,
        seeds = [crate::constants::SESSION_SEED, vault.key().as_ref(), args.live_counterparty.as_ref()],
        bump,
    )]
    pub session: Account<'info, SessionAccount>,
    /// Funds the session PDA rent; receives the vault's freed (shrink) rent.
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

pub fn handler_with_session(
    ctx: Context<MigrateV5ToV6WithSession>,
    args: MigrateV5ToV6WithSessionArgs,
) -> Result<()> {
    let vault_ai = &ctx.accounts.vault;

    // ---- (1) decode the account as a frozen V5 struct (IDENTICAL to handler) --
    let v5: VaultV5Reader = {
        let data = vault_ai.try_borrow_data()?;
        require!(data.len() >= 9, VaultError::UnsupportedVaultVersion);
        require!(
            &data[0..8] == Vault::DISCRIMINATOR,
            VaultError::UnsupportedVaultVersion
        );
        require!(data[8] == VAULT_VERSION_V5, VaultError::UnsupportedVaultVersion);
        let mut cursor: &[u8] = &data[8..];
        VaultV5Reader::deserialize(&mut cursor)?
    }; // drop the data borrow before resize takes a mut borrow

    // ---- (2) authority-gate -----------------------------------------------
    require!(
        v5.dexter_authority == ctx.accounts.dexter_authority.key(),
        VaultError::PasskeyVerificationFailed
    );

    // ---- (3) REQUIRE a live session whose counterparty matches args -------
    // Clone the carried SessionRegistration EARLY so the borrow of
    // `v5.active_session` is released before step (5) consumes v5's other fields.
    let now = Clock::get()?.unix_timestamp;
    let carried: SessionRegistration = v5
        .active_session
        .as_ref()
        .ok_or(error!(VaultError::NoActiveSession))? // must have one
        .clone();
    require!(carried.expires_at > now, VaultError::SessionExpiryInPast); // must be LIVE
    require!(
        carried.allowed_counterparty == args.live_counterparty,
        VaultError::SessionAccountMisderived // caller can't redirect the PDA
    );

    // ---- (4) write the SessionAccount PDA ---------------------------------
    // Different account from the vault — these writes don't touch the vault data
    // borrow. The carried SessionRegistration is stored verbatim.
    {
        let session = &mut ctx.accounts.session;
        session.version = SESSION_VERSION_V1;
        session.bump = ctx.bumps.session;
        session.vault = vault_ai.key();
        session.session = carried;
    }

    // ---- (5) re-encode as the current V6 Vault ----------------------------
    // live_session_count = 1 (the carried session now lives in the PDA);
    // active_session is GONE from the V6 vault. All other fields carried from v5.
    let v6 = Vault {
        version: VAULT_VERSION_V6,
        bump: v5.bump,
        passkey_pubkey: v5.passkey_pubkey,
        swig_address: v5.swig_address,
        cooling_off_seconds: v5.cooling_off_seconds,
        pending_voucher_count: v5.pending_voucher_count,
        pending_withdrawal: v5.pending_withdrawal,
        identity_claim: v5.identity_claim,
        dexter_authority: v5.dexter_authority,
        live_session_count: 1,
        outstanding_locked_amount: v5.outstanding_locked_amount,
        total_crystallized_amount: v5.total_crystallized_amount,
        total_settled_amount: v5.total_settled_amount,
        borrowed: v5.borrowed,
        standby_backer: v5.standby_backer,
        standby_cap: v5.standby_cap,
        borrow_recovery_at: v5.borrow_recovery_at,
    };

    // ---- (6) write the V6 encoding, shrink the vault, refund freed rent ----
    // IDENTICAL resize/refund mechanic to handler().
    let new_size = 8 + Vault::INIT_SPACE;

    {
        let mut data = vault_ai.try_borrow_mut_data()?;
        let mut out = Vec::with_capacity(new_size);
        out.extend_from_slice(Vault::DISCRIMINATOR);
        v6.serialize(&mut out)?;
        // Same fix as handler(): Borsh encodes None options as 1 byte, so the
        // V6 encoding is SHORTER than the INIT_SPACE max. Zero-pad to new_size so
        // the post-resize tail is clean Borsh padding (the None discriminants),
        // never stale V5 bytes. (The old `== new_size` rejected None-bearing vaults.)
        require!(out.len() <= new_size, VaultError::UnsupportedVaultVersion);
        out.resize(new_size, 0);
        require!(out.len() <= data.len(), VaultError::UnsupportedVaultVersion);
        data[..out.len()].copy_from_slice(&out);
    } // drop the data borrow before resize

    vault_ai.resize(new_size)?;

    let rent = Rent::get()?;
    let new_min = rent.minimum_balance(new_size);
    let cur = vault_ai.lamports();
    if cur > new_min {
        let refund = cur - new_min;
        // No aliasing: `payer` is a Signer and the vault is a program-owned PDA,
        // so a caller cannot pass the vault as `payer` (a PDA cannot sign). The
        // two lamport borrows are distinct accounts, sequenced, no double-borrow.
        **vault_ai.try_borrow_mut_lamports()? -= refund;
        **ctx.accounts.payer.to_account_info().try_borrow_mut_lamports()? += refund;
    }

    Ok(())
}
