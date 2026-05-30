use anchor_lang::prelude::*;

/// Current vault layout version. Read from byte 0 of the account; a v2 program
/// rejects accounts whose `version` byte does not match. Future v3 layouts can
/// branch on the same byte to handle each generation explicitly. See
/// docs/DESIGN-vault-v2-session-keys.md §4 for the rationale.
pub const VAULT_VERSION_V2: u8 = 2;

#[account]
#[derive(InitSpace)]
pub struct Vault {
    /// Layout version. MUST be the first field so byte 0 of the deserialized
    /// account directly indicates which Vault generation this is. A program
    /// bound to v2 rejects (`VaultError::UnsupportedVaultVersion`) anything
    /// that isn't `VAULT_VERSION_V2`.
    pub version: u8,
    pub bump: u8,
    pub passkey_pubkey: [u8; 33],
    pub swig_address: Pubkey,
    /// Minimum delay between `request_withdrawal` and `finalize_withdrawal`.
    /// `u32` because negative is meaningless and 136 years of seconds is plenty.
    pub cooling_off_seconds: u32,
    pub pending_voucher_count: u32,
    pub pending_withdrawal: Option<PendingWithdrawal>,
    /// Operator-defined opaque identity claim (formerly `supabase_user_id`).
    /// The protocol does not interpret these bytes; Dexter writes a Supabase
    /// UUID prefix, future operators may write whatever they want. Documented
    /// in the OTS spec as "operator-defined".
    pub identity_claim: [u8; 32],
    /// The session authority recorded at init — the ONLY key permitted to
    /// mutate `pending_voucher_count` (settle_voucher / force_release).
    pub dexter_authority: Pubkey,
    /// Currently-authorized session key, if any. Written by `register_session_key`
    /// (passkey-signed), cleared by `revoke_session_key` (passkey-signed) or by
    /// the program when expiry is observed during a future read. v2 enforces
    /// at most one active session per vault; multi-seller / multi-session is
    /// future work (issue #5).
    pub active_session: Option<SessionRegistration>,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, InitSpace)]
pub struct PendingWithdrawal {
    pub amount: u64,
    pub destination: Pubkey,
    pub requested_at: i64,
}

/// On-chain record of an authorized session key.
///
/// The session pubkey is an ordinary ed25519 keypair the buyer's SDK generated
/// in memory at tab-open time. The passkey signed a 180-byte registration
/// message (see docs/DESIGN-vault-v2-session-keys.md §2.2) endorsing these
/// scope limits. From this point on, the seller's middleware accepts vouchers
/// signed by `session_pubkey` for this vault, up to `max_amount` and before
/// `expires_at`, only for `allowed_counterparty`.
///
/// `spent` is the running cumulative — incremented by settle paths that close
/// vouchers — so we can enforce the cap across the lifetime of the session
/// without an additional read.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, InitSpace)]
pub struct SessionRegistration {
    pub session_pubkey: [u8; 32],
    pub max_amount: u64,
    pub expires_at: i64,
    pub allowed_counterparty: Pubkey,
    pub nonce: u32,
    pub spent: u64,
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
    #[msg("Vault account version is not supported by this program")]
    UnsupportedVaultVersion,
    #[msg("A session is already active on this vault and has not expired")]
    SessionAlreadyActive,
    #[msg("Session expiry must be in the future")]
    SessionExpiryInPast,
    #[msg("Session max_amount must be greater than zero")]
    SessionCapZero,
    #[msg("No active session to revoke")]
    NoActiveSession,
    #[msg("Revocation message session pubkey does not match the active session")]
    SessionPubkeyMismatch,
}
