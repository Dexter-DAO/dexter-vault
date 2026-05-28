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
    if args.increment {
        vault.pending_voucher_count = vault.pending_voucher_count.saturating_add(1);
    } else {
        require!(vault.pending_voucher_count > 0, VaultError::NoPendingWithdrawal);
        vault.pending_voucher_count -= 1;
    }
    let _ = args.amount;
    Ok(())
}
