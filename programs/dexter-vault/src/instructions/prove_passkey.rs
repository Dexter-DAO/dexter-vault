use anchor_lang::prelude::*;
use anchor_lang::solana_program::sysvar;

use crate::state::*;
use crate::verify::webauthn::verify_passkey_signed;

#[derive(Accounts)]
pub struct ProvePasskey<'info> {
    /// Read-only: this instruction proves passkey control and mutates NOTHING.
    pub vault: Account<'info, Vault>,
    /// CHECK: instructions sysvar — address-constrained. Verifies the buyer's
    /// passkey signature via the SIMD-0075 precompile sibling instruction.
    #[account(address = sysvar::instructions::ID)]
    pub instructions_sysvar: AccountInfo<'info>,
}

#[derive(AnchorSerialize, AnchorDeserialize)]
pub struct ProvePasskeyArgs {
    /// The 32-byte challenge to prove control over (e.g. a SIWX login nonce /
    /// digest). The passkey must have signed `"siwx_login" || challenge`.
    pub challenge: [u8; 32],
    /// WebAuthn clientDataJSON; its `challenge` field must base64url-decode to
    /// `sha256("siwx_login" || challenge)`.
    pub client_data_json: Vec<u8>,
    pub authenticator_data: Vec<u8>,
}

/// Prove that the buyer's passkey authorized a challenge — WITHOUT changing any
/// state, moving any funds, or requiring any signer other than the passkey
/// (verified via the SIMD-0075 precompile sibling). This is the Solana
/// equivalent of EIP-1271 "isValidSignature": a verifier can `simulateTransaction`
/// `[secp256r1_verify_ix, prove_passkey_ix]` and treat `err == null` as proof
/// that the passkey controlling this vault signed the challenge. It is the
/// non-custodial basis for Sign-In-With-X: the user's passkey proves identity,
/// not a Dexter-held key.
///
/// Touches nothing. `vault` is read-only. Safe to simulate by anyone; producing
/// a passing simulation requires a genuine passkey signature over the challenge.
pub fn handler(ctx: Context<ProvePasskey>, args: ProvePasskeyArgs) -> Result<()> {
    let vault = &ctx.accounts.vault;
    require!(
        vault.version == VAULT_VERSION_V4 || vault.version == VAULT_VERSION_V3 || vault.version == VAULT_VERSION_V2,
        VaultError::UnsupportedVaultVersion
    );

    // The passkey must have signed "siwx_login" || challenge.
    let mut op_msg = Vec::with_capacity(b"siwx_login".len() + 32);
    op_msg.extend_from_slice(b"siwx_login");
    op_msg.extend_from_slice(&args.challenge);

    verify_passkey_signed(
        &ctx.accounts.instructions_sysvar,
        &vault.passkey_pubkey,
        &args.client_data_json,
        &args.authenticator_data,
        &op_msg,
    )?;

    Ok(())
}
