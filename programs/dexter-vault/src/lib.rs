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

    pub fn migrate_v3_to_v4(
        ctx: Context<MigrateV3ToV4>,
        args: MigrateV3ToV4Args,
    ) -> Result<()> {
        instructions::migrate_v3_to_v4::handler(ctx, args)
    }

    pub fn migrate_v4_to_v5(
        ctx: Context<MigrateV4ToV5>,
        args: MigrateV4ToV5Args,
    ) -> Result<()> {
        instructions::migrate_v4_to_v5::handler(ctx, args)
    }

    pub fn migrate_v5_to_v6(ctx: Context<MigrateV5ToV6>, args: MigrateV5ToV6Args) -> Result<()> {
        instructions::migrate_v5_to_v6::handler(ctx, args)
    }

    pub fn lock_voucher(
        ctx: Context<LockVoucher>,
        args: LockVoucherArgs,
    ) -> Result<()> {
        instructions::lock_voucher::handler(ctx, args)
    }

    pub fn transfer_lock_ownership(
        ctx: Context<TransferLockOwnership>,
        args: TransferLockOwnershipArgs,
    ) -> Result<()> {
        instructions::transfer_lock_ownership::handler(ctx, args)
    }

    pub fn settle_locked_voucher(
        ctx: Context<SettleLockedVoucher>,
        args: SettleLockedVoucherArgs,
    ) -> Result<()> {
        instructions::settle_locked_voucher::handler(ctx, args)
    }

    pub fn recover_abandoned_lock(
        ctx: Context<RecoverAbandonedLock>,
        args: RecoverAbandonedLockArgs,
    ) -> Result<()> {
        instructions::recover_abandoned_lock::handler(ctx, args)
    }

    pub fn open_standby(
        ctx: Context<OpenStandby>,
        args: OpenStandbyArgs,
    ) -> Result<()> {
        instructions::open_standby::handler(ctx, args)
    }

    pub fn draw_credit(
        ctx: Context<DrawCredit>,
        args: DrawCreditArgs,
    ) -> Result<()> {
        instructions::draw_credit::handler(ctx, args)
    }

    pub fn repay_credit(
        ctx: Context<RepayCredit>,
        args: RepayCreditArgs,
    ) -> Result<()> {
        instructions::repay_credit::handler(ctx, args)
    }

    pub fn seize_collateral(
        ctx: Context<SeizeCollateral>,
        args: SeizeCollateralArgs,
    ) -> Result<()> {
        instructions::seize_collateral::handler(ctx, args)
    }

    pub fn set_standby_reserve(
        ctx: Context<SetStandbyReserve>,
        args: SetStandbyReserveArgs,
    ) -> Result<()> {
        instructions::set_standby_reserve::handler(ctx, args)
    }

    pub fn close_standby(
        ctx: Context<CloseStandby>,
        args: CloseStandbyArgs,
    ) -> Result<()> {
        instructions::close_standby::handler(ctx, args)
    }
}
