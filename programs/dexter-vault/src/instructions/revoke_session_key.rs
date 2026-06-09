use anchor_lang::prelude::*;
use anchor_lang::solana_program::sysvar;

use crate::state::*;
use crate::verify::webauthn::verify_passkey_signed;

/// Domain separator for session-key REVOCATION messages. Distinct from the
/// registration domain so a registration signature can never be reinterpreted
/// as a revocation (or vice versa).
///
/// Layout note: 21 bytes of label + 11 NUL = 32 bytes total.
const REVOKE_DOMAIN: &[u8; 32] = b"OTS_SESSION_REVOKE_V1\0\0\0\0\0\0\0\0\0\0\0";

#[derive(Accounts)]
#[instruction(args: RevokeSessionKeyArgs)]
pub struct RevokeSessionKey<'info> {
    /// Mutated to decrement `live_session_count`. No signer required; the passkey
    /// signature in the args is the authorization.
    #[account(mut)]
    pub vault: Account<'info, Vault>,
    /// The session PDA being revoked. mut (we clear it in place). bump from stored.
    /// The seed binds it to (vault, allowed_counterparty), so it cannot be
    /// redirected to a foreign counterparty's session.
    #[account(
        mut,
        seeds = [crate::constants::SESSION_SEED, vault.key().as_ref(), args.allowed_counterparty.as_ref()],
        bump = session.bump,
    )]
    pub session: Account<'info, SessionAccount>,
    /// CHECK: instructions sysvar — address-constrained. The previous
    /// instruction in the transaction MUST be a secp256r1_verify call.
    #[account(address = sysvar::instructions::ID)]
    pub instructions_sysvar: AccountInfo<'info>,
}

#[derive(AnchorSerialize, AnchorDeserialize)]
pub struct RevokeSessionKeyArgs {
    /// The counterparty whose session PDA is being revoked. Goes in the args so
    /// the accounts struct can re-derive the PDA seed.
    pub allowed_counterparty: Pubkey,
    pub client_data_json: Vec<u8>,
    pub authenticator_data: Vec<u8>,
}

/// Buyer's passkey explicitly tears down a named session (V6).
///
/// Two uses:
///  - The buyer closed their tab and wants to make absolutely sure no further
///    vouchers can be signed under the previous session (defense in depth;
///    expiry would do it eventually anyway).
///  - The buyer suspects the session key leaked and wants to kill it NOW
///    rather than wait for expiry.
///
/// Semantics: immediate. Vouchers signed after this instruction lands are
/// intentionally void. Sellers learn at the next voucher verification — the
/// registration's session pubkey will no longer match a live session PDA, so
/// the seller's local check fails and the voucher is rejected.
///
/// No grace period. The buyer revoked deliberately; vouchers signed against
/// the revoked session are by definition unauthorized. This is the §12.4
/// design decision.
///
/// CLEAR-not-CLOSE (spec §5): revoke does NOT close the PDA or refund rent. It
/// zeroes `version` (so the next register to this counterparty is treated as a
/// first-touch create) and zeroes every SessionRegistration field, then decrements
/// `live_session_count`. NOTE: exclusion of this session from future overcommit
/// sibling sets is via the `live_session_count` decrement below + the register-time
/// completeness equation — NOT via the sweep (a cleared session must not be passed
/// as a sibling at all; doing so reverts the register via completeness/checked_sub).
/// Closing-and-refunding in the same tx opens a sealevel revival-attack window (a
/// refunded account revived with stale state); the rent (~$0.12) stays parked and a
/// future `close_session` ix reclaims it.
pub fn handler(ctx: Context<RevokeSessionKey>, args: RevokeSessionKeyArgs) -> Result<()> {
    // ── Version gate → V6 (only V6 vaults carry SessionAccount PDAs). ─────────
    require!(
        ctx.accounts.vault.version == VAULT_VERSION_V6,
        VaultError::UnsupportedVaultVersion
    );

    // ── Guard: the session must be live/registered. version==0 means it was
    //    never touched, or already cleared by a prior revoke / expiry sweep. ──
    require!(
        ctx.accounts.session.version != 0,
        VaultError::NoActiveSession
    );

    // The passkey's revocation message includes the specific session pubkey
    // being revoked — now read from the session PDA, not vault.active_session.
    // This prevents a stale-revocation replay from being accepted against a NEW
    // session: if the buyer rotates the session for this counterparty, an
    // attacker holding an old revocation signature can't use it to kill the new
    // one because the session_pubkey field won't match.
    //
    // Copy the scalars the verify step needs BEFORE taking any `&mut` borrow.
    let vault_key = ctx.accounts.vault.key();
    let passkey = ctx.accounts.vault.passkey_pubkey;
    let session_pubkey = ctx.accounts.session.session.session_pubkey;

    let revocation_message =
        build_revocation_message(ctx.program_id, &vault_key, &session_pubkey);

    verify_passkey_signed(
        &ctx.accounts.instructions_sysvar,
        &passkey,
        &args.client_data_json,
        &args.authenticator_data,
        &revocation_message,
    )?;

    // ── CLEAR (not close) the session PDA. ───────────────────────────────────
    // Zero the version (next register to this counterparty is a first-touch create)
    // and zero every SessionRegistration field (revival-class defense). Field set
    // matches register_session_key's expired-sibling sweep verbatim.
    let session = &mut ctx.accounts.session;
    session.version = 0;
    session.session = SessionRegistration {
        session_pubkey: [0u8; 32],
        max_amount: 0,
        expires_at: 0,
        allowed_counterparty: Pubkey::default(),
        nonce: 0,
        spent: 0,
        current_outstanding: 0,
        max_revolving_capacity: 0,
        crystallized_cumulative: 0,
        last_locked_sequence: 0,
    };

    // ── Decrement the live count (separate &mut borrow; different account). ───
    // checked_sub (NOT saturating): the liveness guard above proves a live session
    // PDA exists ⇒ live_session_count >= 1, so this can't legitimately underflow.
    // If it ever did (version!=0 && count==0), that's state corruption — fail CLOSED
    // rather than mask it, matching register's count math (which also uses checked_sub).
    let vault = &mut ctx.accounts.vault;
    vault.live_session_count = vault
        .live_session_count
        .checked_sub(1)
        .ok_or(error!(VaultError::IncompleteSessionSet))?;

    Ok(())
}

/// Deterministic 128-byte serialization of the revocation message.
///
/// Layout:
///   [  0..32) domain separator literal "OTS_SESSION_REVOKE_V1\0\0\0\0\0\0\0\0\0\0\0"
///   [ 32..64) program ID
///   [ 64..96) vault PDA
///   [ 96..128) session_pubkey being revoked (read from the session PDA)
fn build_revocation_message(
    program_id: &Pubkey,
    vault_pda: &Pubkey,
    session_pubkey: &[u8; 32],
) -> Vec<u8> {
    let mut msg = Vec::with_capacity(128);
    msg.extend_from_slice(REVOKE_DOMAIN);
    msg.extend_from_slice(program_id.as_ref());
    msg.extend_from_slice(vault_pda.as_ref());
    msg.extend_from_slice(session_pubkey);
    debug_assert_eq!(msg.len(), 128);
    msg
}
