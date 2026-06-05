use anchor_lang::prelude::*;

declare_id!("Hg3wRaydFtJhYrdvYrKECacpJYDsC9Px7yKmpncj2fhc");

pub mod constants;
pub mod state;
pub mod instructions;
pub mod swig_compat;
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

    pub fn set_swig(
        ctx: Context<SetSwig>,
        args: SetSwigArgs,
    ) -> Result<()> {
        instructions::set_swig::handler(ctx, args)
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
        args: FinalizeWithdrawalArgs,
    ) -> Result<()> {
        instructions::finalize_withdrawal::handler(ctx, args)
    }

    pub fn force_release(ctx: Context<ForceRelease>, args: ForceReleaseArgs) -> Result<()> {
        instructions::force_release::handler(ctx, args)
    }

    pub fn rotate_passkey(ctx: Context<RotatePasskey>, args: RotatePasskeyArgs) -> Result<()> {
        instructions::rotate_passkey::handler(ctx, args)
    }

    pub fn rotate_dexter_authority(
        ctx: Context<RotateDexterAuthority>,
        args: RotateDexterAuthorityArgs,
    ) -> Result<()> {
        instructions::rotate_dexter_authority::handler(ctx, args)
    }

    pub fn prove_passkey(ctx: Context<ProvePasskey>, args: ProvePasskeyArgs) -> Result<()> {
        instructions::prove_passkey::handler(ctx, args)
    }

    pub fn register_session_key(
        ctx: Context<RegisterSessionKey>,
        args: RegisterSessionKeyArgs,
    ) -> Result<()> {
        instructions::register_session_key::handler(ctx, args)
    }

    pub fn revoke_session_key(
        ctx: Context<RevokeSessionKey>,
        args: RevokeSessionKeyArgs,
    ) -> Result<()> {
        instructions::revoke_session_key::handler(ctx, args)
    }

    pub fn settle_tab_voucher(
        ctx: Context<SettleTabVoucher>,
        args: SettleTabVoucherArgs,
    ) -> Result<()> {
        instructions::settle_tab_voucher::handler(ctx, args)
    }

    pub fn set_swig_atomic(
        ctx: Context<SetSwigAtomic>,
        args: SetSwigAtomicArgs,
    ) -> Result<()> {
        instructions::set_swig_atomic::handler(ctx, args)
    }

    pub fn migrate_v2_to_v3(
        ctx: Context<MigrateV2ToV3>,
        args: MigrateV2ToV3Args,
    ) -> Result<()> {
        instructions::migrate_v2_to_v3::handler(ctx, args)
    }
}
