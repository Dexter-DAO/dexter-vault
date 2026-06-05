use anchor_lang::prelude::*;
use anchor_lang::solana_program::sysvar;

use crate::state::*;
use crate::verify::webauthn::verify_passkey_signed;

/// Domain separator for session-key REVOCATION messages. Distinct from the
/// registration domain so a registration signature can never be reinterpreted
/// as a revocation (or vice versa).
///
/// Layout note: 22 bytes of label + 10 NUL = 32 bytes total.
const REVOKE_DOMAIN: &[u8; 32] = b"OTS_SESSION_REVOKE_V1\0\0\0\0\0\0\0\0\0\0\0";

#[derive(Accounts)]
pub struct RevokeSessionKey<'info> {
    /// Mutated to clear `active_session`. No signer required; the passkey
    /// signature in the args is the authorization.
    #[account(mut)]
    pub vault: Account<'info, Vault>,
    /// CHECK: instructions sysvar — address-constrained. The previous
    /// instruction in the transaction MUST be a secp256r1_verify call.
    #[account(address = sysvar::instructions::ID)]
    pub instructions_sysvar: AccountInfo<'info>,
}

#[derive(AnchorSerialize, AnchorDeserialize)]
pub struct RevokeSessionKeyArgs {
    pub client_data_json: Vec<u8>,
    pub authenticator_data: Vec<u8>,
}

/// Buyer's passkey explicitly tears down the current session.
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
/// registration's session pubkey will no longer match a vault-side active
/// session, so the seller's local check fails and the voucher is rejected.
///
/// No grace period. The buyer revoked deliberately; vouchers signed against
/// the revoked session are by definition unauthorized. This is the §12.4
/// design decision.
pub fn handler(ctx: Context<RevokeSessionKey>, args: RevokeSessionKeyArgs) -> Result<()> {
    let vault = &mut ctx.accounts.vault;

    require!(
        vault.version == VAULT_VERSION_V4 || vault.version == VAULT_VERSION_V3 || vault.version == VAULT_VERSION_V2,
        VaultError::UnsupportedVaultVersion
    );

    let session = vault
        .active_session
        .as_ref()
        .ok_or(VaultError::NoActiveSession)?
        .clone();

    // The passkey's revocation message includes the specific session pubkey
    // being revoked. This prevents a stale-revocation replay from being
    // accepted against a NEW session: if the buyer rotates sessions, an
    // attacker holding an old revocation signature can't use it to kill the
    // new one because the session pubkey field won't match.
    let revocation_message =
        build_revocation_message(ctx.program_id, &vault.key(), &session.session_pubkey);

    verify_passkey_signed(
        &ctx.accounts.instructions_sysvar,
        &vault.passkey_pubkey,
        &args.client_data_json,
        &args.authenticator_data,
        &revocation_message,
    )?;

    vault.active_session = None;
    Ok(())
}

/// Deterministic 128-byte serialization of the revocation message.
///
/// Layout:
///   [  0..32) domain separator literal "OTS_SESSION_REVOKE_V1\0\0\0\0\0\0\0\0\0\0\0"
///   [ 32..64) program ID
///   [ 64..96) vault PDA
///   [ 96..128) session_pubkey being revoked (from active_session)
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
