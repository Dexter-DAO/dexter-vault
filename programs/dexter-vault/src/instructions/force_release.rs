use anchor_lang::prelude::*;
use anchor_lang::solana_program::sysvar;

use crate::state::*;
use crate::verify::webauthn::verify_passkey_signed;

/// Grace period before a stuck voucher can be force-released. Measured from
/// the buyer's `request_withdrawal` timestamp — the buyer has signalled they
/// want out and has been blocked by a non-zero count for this long.
///
/// This window is ALSO the seller's protection: a settlement has this entire
/// period to land and legitimately clear the count before the buyer can force
/// anything. A malicious buyer cannot shorten it. It only matters in the
/// pathological case where settlement never lands at all (which the confirmed
/// decrement on the caller side makes vanishingly rare).
pub const FORCE_RELEASE_GRACE_SECONDS: i64 = 7 * 24 * 60 * 60; // 7 days

#[derive(Accounts)]
pub struct ForceRelease<'info> {
    #[account(mut)]
    pub vault: Account<'info, Vault>,
    /// CHECK: instructions sysvar — address-constrained. Used to verify the
    /// buyer's passkey signature via the SIMD-0075 precompile sibling.
    #[account(address = sysvar::instructions::ID)]
    pub instructions_sysvar: AccountInfo<'info>,
}

#[derive(AnchorSerialize, AnchorDeserialize)]
pub struct ForceReleaseArgs {
    /// WebAuthn clientDataJSON; challenge must be sha256(operation_message).
    pub client_data_json: Vec<u8>,
    pub authenticator_data: Vec<u8>,
}

/// Recovery valve for Finding A, controlled by the BUYER — not Dexter.
///
/// A settlement that can never land leaves `pending_voucher_count` stuck above
/// zero, permanently blocking the buyer's withdrawal. Rather than hand Dexter
/// a lever to clear it (which would make access to the buyer's own funds
/// depend on Dexter's goodwill), the buyer clears it themselves with their
/// passkey — but ONLY after the grace period, so it cannot be used to escape a
/// live tab mid-session.
///
/// Why this does NOT reintroduce the malicious-buyer drain: the grace window
/// is the seller's guaranteed settlement window. Trace a malicious buyer —
/// they open a tab (count=1), run up charges, sign request_withdrawal, and try
/// to force_release. It is rejected until the grace elapses. During that
/// entire window the seller can settle and capture the funds (the normal
/// decrement). The buyer only escapes if the seller fails to settle for the
/// full grace period — i.e. an abandoned claim, not a defrauded one. Who holds
/// the key (buyer vs Dexter) does not change this; the protection is the grace
/// window plus reliable settlement.
///
/// Invariant: this mutates only the counter (withdrawal timing). It never
/// moves funds — finalize_withdrawal still requires a separate passkey sig.
pub fn handler(ctx: Context<ForceRelease>, args: ForceReleaseArgs) -> Result<()> {
    let vault = &mut ctx.accounts.vault;
    require!(
        vault.version == VAULT_VERSION_V4 || vault.version == VAULT_VERSION_V3 || vault.version == VAULT_VERSION_V2,
        VaultError::UnsupportedVaultVersion
    );

    require!(vault.pending_voucher_count > 0, VaultError::NothingToRelease);

    let pending = vault
        .pending_withdrawal
        .clone()
        .ok_or(VaultError::NothingToRelease)?;

    let now = Clock::get()?.unix_timestamp;
    let waited = now.saturating_sub(pending.requested_at).max(0);
    require!(
        waited >= FORCE_RELEASE_GRACE_SECONDS,
        VaultError::ForceReleaseTooEarly
    );

    // The buyer must sign this exact action with their passkey. Bind the
    // message to the vault's swig so a signature cannot be replayed elsewhere.
    let mut op_msg = Vec::with_capacity(b"force_release".len() + 32);
    op_msg.extend_from_slice(b"force_release");
    op_msg.extend_from_slice(vault.swig_address.as_ref());

    verify_passkey_signed(
        &ctx.accounts.instructions_sysvar,
        &vault.passkey_pubkey,
        &args.client_data_json,
        &args.authenticator_data,
        &op_msg,
    )?;

    // Release exactly one stuck voucher. Repeated calls (each still gated by
    // the grace condition + a fresh passkey signature) can clear more.
    vault.pending_voucher_count -= 1;

    Ok(())
}
