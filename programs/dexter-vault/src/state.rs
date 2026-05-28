use anchor_lang::prelude::*;

#[account]
#[derive(InitSpace)]
pub struct Vault {
    pub bump: u8,
    pub passkey_pubkey: [u8; 33],
    pub swig_address: Pubkey,
    pub cooling_off_seconds: i64,
    pub pending_voucher_count: u32,
    pub pending_withdrawal: Option<PendingWithdrawal>,
    pub supabase_user_id: [u8; 16],
    /// Dexter session authority — the ONLY key permitted to mutate
    /// `pending_voucher_count` (settle_voucher / force_release). Recorded at
    /// init. This gates the counter (withdrawal *timing*), never the exit:
    /// funds always require the buyer's passkey via finalize_withdrawal.
    pub dexter_authority: Pubkey,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, InitSpace)]
pub struct PendingWithdrawal {
    pub amount: u64,
    pub destination: Pubkey,
    pub requested_at: i64,
}

#[error_code]
pub enum VaultError {
    #[msg("Cooling-off period has not elapsed")]
    CoolingOffNotElapsed,
    #[msg("Pending vouchers must settle before withdrawal can finalize")]
    PendingVouchersExist,
    #[msg("No pending withdrawal request")]
    NoPendingWithdrawal,
    #[msg("Passkey signature verification failed")]
    PasskeyVerificationFailed,
    #[msg("Voucher signature does not match Dexter session key")]
    InvalidVoucherSignature,
    #[msg("force_release grace period has not elapsed")]
    ForceReleaseTooEarly,
    #[msg("No stuck voucher to force-release")]
    NothingToRelease,
}
