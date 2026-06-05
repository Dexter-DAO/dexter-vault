use anchor_lang::prelude::*;

use crate::state::*;

#[derive(Accounts)]
pub struct SettleVoucher<'info> {
    #[account(mut, has_one = dexter_authority @ VaultError::PasskeyVerificationFailed)]
    pub vault: Account<'info, Vault>,
    /// Must equal the `dexter_authority` recorded on the vault at init.
    /// `has_one` enforces this — closing Finding B (previously any signer
    /// could mutate the counter).
    pub dexter_authority: Signer<'info>,
}

#[derive(AnchorSerialize, AnchorDeserialize)]
pub struct SettleVoucherArgs {
    pub amount: u64,
    pub increment: bool,
}

pub fn handler(ctx: Context<SettleVoucher>, args: SettleVoucherArgs) -> Result<()> {
    let vault = &mut ctx.accounts.vault;
    require!(
        vault.version == VAULT_VERSION_V3 || vault.version == VAULT_VERSION_V2,
        VaultError::UnsupportedVaultVersion
    );
    if args.increment {
        vault.pending_voucher_count = vault.pending_voucher_count.saturating_add(1);
        // Capture exposure: the credex meter's RISE seam. The amount the
        // facilitator passes at tab-open was previously discarded
        // (`let _ = args.amount`). Now it raises live outstanding exposure,
        // admission-capped by the session's max_revolving_capacity.
        if let Some(session) = vault.active_session.as_mut() {
            let new_outstanding = session
                .current_outstanding
                .checked_add(args.amount)
                .ok_or(VaultError::RevolvingCapacityExceeded)?;
            require!(
                new_outstanding <= session.max_revolving_capacity,
                VaultError::RevolvingCapacityExceeded
            );
            session.current_outstanding = new_outstanding;
        }
    } else {
        require!(vault.pending_voucher_count > 0, VaultError::NoPendingWithdrawal);
        vault.pending_voucher_count -= 1;
        // No meter change here: the bare-counter decrement is the non-value
        // close marker. Real exposure release happens in settle_tab_voucher
        // (atomic with the USDC transfer).
    }
    Ok(())
}
