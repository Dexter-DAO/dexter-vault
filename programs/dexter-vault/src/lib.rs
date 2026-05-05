use anchor_lang::prelude::*;

declare_id!("Hg3wRaydFtJhYrdvYrKECacpJYDsC9Px7yKmpncj2fhc");

pub mod state;
pub mod instructions;
pub mod verify;

use instructions::*;

#[program]
pub mod dexter_vault {
    use super::*;

    pub fn initialize_vault(
        ctx: Context<InitializeVault>,
        args: InitializeVaultArgs,
    ) -> Result<()> {
        instructions::initialize_vault::handler(ctx, args)
    }

    pub fn settle_voucher(
        ctx: Context<SettleVoucher>,
        args: SettleVoucherArgs,
    ) -> Result<()> {
        instructions::settle_voucher::handler(ctx, args)
    }

    pub fn request_withdrawal(
        ctx: Context<RequestWithdrawal>,
        args: RequestWithdrawalArgs,
    ) -> Result<()> {
        instructions::request_withdrawal::handler(ctx, args)
    }

    pub fn finalize_withdrawal(
        ctx: Context<FinalizeWithdrawal>,
    ) -> Result<()> {
        instructions::finalize_withdrawal::handler(ctx)
    }
}
