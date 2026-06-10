use anchor_lang::prelude::*;

use crate::state::*;

#[derive(Accounts)]
#[instruction(args: CloseSessionArgs)]
pub struct CloseSession<'info> {
    /// Read-only: the version + authority gates read it, nothing mutates it.
    /// `has_one` enforces vault.dexter_authority == dexter_authority.key()
    /// (the same authority-gate shape settle_voucher uses, same error mapping).
    #[account(has_one = dexter_authority @ VaultError::PasskeyVerificationFailed)]
    pub vault: Account<'info, Vault>,

    /// The CLEARED session PDA being closed. A cleared session has every
    /// SessionRegistration field zeroed (including `allowed_counterparty`), so
    /// the binding to (vault, counterparty) cannot be read from the account
    /// body — the PDA SEEDS are the proof: only the canonical PDA for
    /// (vault, args.allowed_counterparty) satisfies this constraint. Bump from
    /// stored (`session.bump`), matching revoke_session_key — register stamps
    /// the canonical bump at first touch and neither revoke nor the register-
    /// time expired-sibling sweep ever zeroes `bump` (or `vault`), so it is
    /// valid on a cleared account.
    ///
    /// `close = dexter_authority` — Anchor 0.32.1 close semantics (verified in
    /// anchor-lang 0.32.1 src/common.rs::close): drains ALL lamports to the
    /// destination, reassigns the account to the System Program, and resizes
    /// data to 0. No stale bytes survive and the account is no longer
    /// program-owned, so a same-transaction revival (re-funding the emptied
    /// account with stale state) is structurally impossible — there is no
    /// state left to revive and `Account<SessionAccount>` deserialization
    /// would fail the owner check anyway.
    #[account(
        mut,
        close = dexter_authority,
        seeds = [crate::constants::SESSION_SEED, vault.key().as_ref(), args.allowed_counterparty.as_ref()],
        bump = session.bump,
    )]
    pub session: Account<'info, SessionAccount>,

    /// The vault's recorded dexter_authority — must sign, and receives the
    /// reclaimed rent (hence `mut`). Authority-only in v1 by design: the
    /// authority operationally funds session-PDA rent in the hosted flow, so
    /// the rent returns to the party that fronted it.
    #[account(mut)]
    pub dexter_authority: Signer<'info>,
}

#[derive(AnchorSerialize, AnchorDeserialize)]
pub struct CloseSessionArgs {
    /// The counterparty whose CLEARED session PDA is being closed. Goes in the
    /// args so the accounts struct can re-derive the PDA seed — the account
    /// body's own copy of this field is zeroed on a cleared session, so the
    /// seed derivation is the only binding.
    pub allowed_counterparty: Pubkey,
}

/// Reclaim the rent parked in a CLEARED session PDA (V6).
///
/// `revoke_session_key` (and the register-time expired-sibling sweep) CLEARs a
/// session PDA — zeroes `version` + every SessionRegistration field — but never
/// closes it, because clearing and refunding in the same instruction as other
/// state transitions opens the sealevel revival-attack window (spec §5,
/// CLEAR-not-CLOSE). That parks ~0.0021 SOL of rent per revoked tab forever.
/// This instruction is the deferred second half: once a session is cleared,
/// closing it is pure rent reclamation with no protocol state attached.
///
/// Gates (all hard requires / constraints):
///   1. vault.version == VAULT_VERSION_V6 (only V6 vaults carry session PDAs)
///   2. vault.dexter_authority signs and receives the rent (has_one + Signer)
///   3. session.version == 0 — ONLY cleared sessions are closable. A LIVE
///      session (version == SESSION_VERSION_V1) must be revoked first
///      (`SessionStillLive`): revoke is the passkey-authorized teardown that
///      decrements `live_session_count`; close is just the janitor.
///
/// `live_session_count` is deliberately NOT touched here: a cleared session
/// already left the live set at revoke/sweep time (that's where the decrement
/// happened). Closing the empty shell changes nothing the count tracks.
///
/// Interaction contracts (preserved, by construction):
///   - After close, `register_session_key` for the same (vault, counterparty)
///     works unchanged via init_if_needed: the PDA address is vacant again, so
///     init runs the CREATE path (payer funds rent, version 0 → first-touch,
///     live_session_count increments normally).
///   - The register-time sibling-completeness gate is unaffected: that gate
///     counts session PDAs that EXIST (live ones summed, expired ones swept);
///     a closed PDA simply does not exist — getProgramAccounts won't return it
///     and the caller has nothing to pass. A cleared-but-unclosed sibling
///     (version==0, expires_at==0) would be counted as "expired/swept" if
///     passed, but the completeness equation never required it (its decrement
///     already happened), so closing it changes no caller obligation.
pub fn handler(ctx: Context<CloseSession>, _args: CloseSessionArgs) -> Result<()> {
    // ── Version gate → V6 (only V6 vaults carry SessionAccount PDAs). ────────
    require!(
        ctx.accounts.vault.version == VAULT_VERSION_V6,
        VaultError::UnsupportedVaultVersion
    );

    // ── Cleared-only gate: version==0 means revoked (or swept-expired). A live
    //    session must go through revoke_session_key first — that's the passkey-
    //    authorized path that also keeps live_session_count consistent. ───────
    require!(
        ctx.accounts.session.version == 0,
        VaultError::SessionStillLive
    );

    // No state mutation here. The actual close (lamport drain → dexter_authority,
    // owner → System Program, data resized to 0) is performed by Anchor's
    // `close = dexter_authority` constraint during account exit, after this
    // handler returns Ok. live_session_count is intentionally untouched (see
    // doc-comment above).
    Ok(())
}
