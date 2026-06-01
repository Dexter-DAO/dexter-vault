use anchor_lang::prelude::*;
use anchor_lang::solana_program::sysvar;

use crate::constants::{SWIG_PROGRAM_ID, SWIG_WALLET_ADDRESS_SEED};
use crate::state::*;
use crate::verify::webauthn::verify_passkey_signed;

#[derive(Accounts)]
pub struct FinalizeWithdrawal<'info> {
    /// Position 0 — REQUIRED at this index by Swig's ProgramExec authority
    /// validator. When a Swig::SignV2 follows this instruction in the same
    /// transaction, Swig's on-chain validator inspects accounts[0..1] of the
    /// preceding instruction and rejects unless they're [swig, swig_wallet].
    ///
    /// We additionally enforce `swig.key() == vault.swig_address` via the
    /// `address` constraint so a caller cannot pass an arbitrary Swig account
    /// in here — defense in depth: even if Swig's own validation changes in a
    /// future program upgrade, this vault keeps its own invariant.
    ///
    /// CHECK: address constraint binds it to vault.swig_address; we never
    /// deserialize or dereference it.
    #[account(address = vault.swig_address)]
    pub swig: AccountInfo<'info>,
    /// Position 1 — required by Swig's ProgramExec validator (see `swig`).
    /// The Swig wallet address is the PDA owning the SPL token ATA being
    /// debited; it is derived under the Swig program at
    /// `["swig-wallet-address", swig_pubkey]`.
    ///
    /// We independently verify the canonical derivation via Anchor's `seeds`
    /// + `seeds::program` constraint. If a caller supplied a fake account, our
    /// program rejects before any Swig CPI runs — we do not rely on Swig
    /// catching it downstream.
    ///
    /// CHECK: PDA constraint validates derivation; not deserialized.
    #[account(
        seeds = [SWIG_WALLET_ADDRESS_SEED, swig.key().as_ref()],
        bump,
        seeds::program = SWIG_PROGRAM_ID,
    )]
    pub swig_wallet_address: AccountInfo<'info>,
    #[account(mut)]
    pub vault: Account<'info, Vault>,
    /// CHECK: instructions sysvar — address-constrained.
    #[account(address = sysvar::instructions::ID)]
    pub instructions_sysvar: AccountInfo<'info>,
}

#[derive(AnchorSerialize, AnchorDeserialize)]
pub struct FinalizeWithdrawalArgs {
    /// WebAuthn clientDataJSON; challenge must be sha256(operation_message).
    pub client_data_json: Vec<u8>,
    pub authenticator_data: Vec<u8>,
}

pub fn handler(ctx: Context<FinalizeWithdrawal>, args: FinalizeWithdrawalArgs) -> Result<()> {
    let vault = &mut ctx.accounts.vault;
    let pending = vault
        .pending_withdrawal
        .clone()
        .ok_or(VaultError::NoPendingWithdrawal)?;

    // Anchor's `address = vault.swig_address` constraint on the `swig` account
    // already enforces that the supplied swig matches the bound address. The
    // additional non-default check below is paranoia: if set_swig was never
    // called, vault.swig_address is the zero Pubkey, which Anchor would happily
    // match against a zero account. Fail fast and explicit.
    require!(
        vault.swig_address != Pubkey::default(),
        VaultError::NoPendingWithdrawal
    );

    let now = Clock::get()?.unix_timestamp;
    // i64 unix timestamps minus another i64 timestamp; clamp to non-negative
    // (a future-dated `requested_at` would otherwise wrap), then promote both
    // sides to u64 so the comparison against the u32 cooling-off field is
    // unambiguous and overflow-safe across the full timestamp range.
    let elapsed_secs = now.saturating_sub(pending.requested_at).max(0) as u64;
    require!(
        elapsed_secs >= vault.cooling_off_seconds as u64,
        VaultError::CoolingOffNotElapsed
    );
    require!(vault.pending_voucher_count == 0, VaultError::PendingVouchersExist);
    require!(vault.version == VAULT_VERSION_V2, VaultError::UnsupportedVaultVersion);

    let mut op_msg = Vec::with_capacity(b"finalize_withdrawal".len() + 8 + 32);
    op_msg.extend_from_slice(b"finalize_withdrawal");
    op_msg.extend_from_slice(&pending.amount.to_le_bytes());
    op_msg.extend_from_slice(pending.destination.as_ref());

    verify_passkey_signed(
        &ctx.accounts.instructions_sysvar,
        &vault.passkey_pubkey,
        &args.client_data_json,
        &args.authenticator_data,
        &op_msg,
    )?;

    vault.pending_withdrawal = None;

    Ok(())
}
