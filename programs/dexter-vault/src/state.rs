use anchor_lang::prelude::*;

/// Current vault layout version. Read from byte 0 of the account; a v2 program
/// rejects accounts whose `version` byte does not match. Future v3 layouts can
/// branch on the same byte to handle each generation explicitly. See
/// docs/DESIGN-vault-v2-session-keys.md §4 for the rationale.
pub const VAULT_VERSION_V2: u8 = 2;

/// v3 adds the credex meter fields (current_outstanding, max_revolving_capacity)
/// to SessionRegistration, enlarging Vault::INIT_SPACE. New vaults init as v3.
/// v2 vaults keep working on lock-only paths but cannot register a revolving
/// (enlarged) session. See docs/superpowers/plans/2026-06-02-revolving-capacity-meter.md.
pub const VAULT_VERSION_V3: u8 = 3;

/// V4 appends LockedClaim accounting: three u64s to `Vault`
/// (`outstanding_locked_amount`, `total_crystallized_amount`, `total_settled_amount`)
/// and `crystallized_cumulative: u64` + `last_locked_sequence: u32` to
/// `SessionRegistration`. Enlarges `Vault::INIT_SPACE`. New vaults init as V4.
pub const VAULT_VERSION_V4: u8 = 4;

/// V5 appends credit accounting: external-financier standby backing.
/// `borrowed` is the "buyer is negative" accumulator. New vaults init as V5.
pub const VAULT_VERSION_V5: u8 = 5;

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
    /// Sum of unsettled LockedClaim amounts for this vault. Rises at
    /// `lock_voucher`, falls at `settle_locked_voucher` / `recover_abandoned_lock`.
    /// The crystallized (buyer-irrevocable) reservation tier. Read by
    /// `finalize_withdrawal` to reject withdrawals that would violate the
    /// reservation. (Seam spec section 1.)
    pub outstanding_locked_amount: u64,
    /// Lifetime monotonic locked-into-claim odometer at vault scope. Never decremented.
    pub total_crystallized_amount: u64,
    /// Lifetime monotonic settled-from-claim odometer at vault scope. Never decremented.
    pub total_settled_amount: u64,
    /// V5: amount an external financier has fronted that the buyer has NOT
    /// repaid. The credit ("buyer is negative") accumulator. Rises at
    /// `draw_credit`, falls at `repay_credit` / `seize_collateral`. MUST never
    /// exceed `standby_cap`.
    pub borrowed: u64,
    /// V5: the financier's vault (swig_address) authorized to back this vault
    /// past the user's own balance. `None` = no credit enabled. Set by
    /// `open_standby`.
    pub standby_backer: Option<Pubkey>,
    /// V5: the ceiling the financier committed. `borrowed <= standby_cap` always.
    pub standby_cap: u64,
    /// V5: deadline after which the financier may `seize_collateral`. Set on the
    /// first draw, cleared when `borrowed` returns to 0. None = nothing borrowed.
    pub borrow_recovery_at: Option<i64>,
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
    /// Live unsettled exposure. Rises at tab-open (settle_voucher increment),
    /// falls at confirmed settle (settle_tab_voucher). This is the field that
    /// REVOLVES — the credex meter.
    pub current_outstanding: u64,
    /// Admission cap the revolving meter is checked against. Set + passkey-
    /// endorsed at register_session_key. May be <= max_amount.
    pub max_revolving_capacity: u64,
    /// Session-scope monotonic locked-into-claim odometer; mirror of `spent`
    /// for the lock terminal path. Rises at `lock_voucher`. Never decremented.
    /// The XOR frontier `max(spent, crystallized_cumulative)` gates both
    /// terminal paths (seam spec section 4). (Seam spec section 1.)
    pub crystallized_cumulative: u64,
    /// Last voucher sequence number that was locked. Reserved for future
    /// out-of-order lock detection — NOT the XOR guard (the frontier is).
    pub last_locked_sequence: u32,
}

/// Crystallized claim against vault USDC. Created by `lock_voucher`,
/// transferable via `transfer_lock_ownership`, settled by
/// `settle_locked_voucher`, reclaimed by `recover_abandoned_lock`. Independent
/// of `active_session` after creation — see V0.3 Decision 7. State machine
/// per V0.3 Decision 6: pending → {settled, abandoned}, both terminal one-way.
#[account]
#[derive(InitSpace)]
pub struct LockedClaim {
    /// Layout version. v0.3 is the first version.
    pub version: u8,
    pub bump: u8,
    /// Vault PDA this claim is reserved against. All reservation invariants
    /// gate on this vault's `outstanding_locked_amount`.
    pub vault: Pubkey,
    /// Session pubkey that signed the voucher being crystallized. Snapshot at
    /// lock time per V0.3 Decision 7; never re-read at settlement.
    pub session_pubkey_at_lock: [u8; 32],
    /// Voucher payload hash — sha256 of the 44-byte canonical voucher message.
    /// For audit / indexer correlation; not re-verified at settle.
    pub voucher_hash: [u8; 32],
    /// USDC amount this claim reserves against the vault. `delta` from
    /// `voucher.cumulative_amount - session.crystallized_cumulative` at lock.
    pub amount: u64,
    /// Wall-clock time the lock instruction landed.
    pub created_at: i64,
    /// Earliest time settlement may run. If None, claim is instantly
    /// settleable.
    pub maturity_at: Option<i64>,
    /// Earliest time the buyer's passkey may reclaim. If None, claim is
    /// indefinitely buyer-irrevocable. Invariant: when both set, MUST satisfy
    /// `holder_recovery_at > maturity_at` per V0.3 Decision 4.
    pub holder_recovery_at: Option<i64>,
    /// Current owner. Set at creation to the seller; mutated by
    /// `transfer_lock_ownership` signed by the previous holder.
    pub current_holder: Pubkey,
    /// State machine status per V0.3 Decision 6.
    pub status: LockedClaimStatus,
    /// Set when status == Settled. None otherwise.
    pub settled_at: Option<i64>,
    /// Set when status == Abandoned. None otherwise.
    pub recovered_at: Option<i64>,
}

/// Claim state per V0.3 Decision 6 state machine.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq, InitSpace)]
pub enum LockedClaimStatus {
    Pending,
    Settled,
    Abandoned,
}

/// LockedClaim PDA seed prefix. Per-claim PDA derived as
/// `[LOCKED_CLAIM_SEED, vault_pda, voucher_hash]` so each unique voucher
/// crystallizes to a unique account address.
pub const LOCKED_CLAIM_SEED: &[u8] = b"locked-claim";

/// LockedClaim layout version.
pub const LOCKED_CLAIM_VERSION_V1: u8 = 1;

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
    #[msg("Opening this tab would exceed the session's revolving capacity")]
    RevolvingCapacityExceeded,
    #[msg("max_revolving_capacity must be greater than zero")]
    RevolvingCapacityZero,
    #[msg("Voucher's cumulative_amount does not advance the XOR frontier (already covered by spent or crystallized_cumulative)")]
    LockRangeAlreadyClaimed,
    #[msg("Locking this voucher would push outstanding_locked_amount above vault USDC balance")]
    LockWouldOvercommitVault,
    #[msg("Finalizing this withdrawal would bring vault balance below outstanding_locked_amount")]
    WithdrawalWouldViolateReservation,
    #[msg("Registering this session would push max_amount + outstanding_locked_amount above vault USDC balance")]
    SessionWouldOvercommitVault,
    #[msg("holder_recovery_at must be strictly greater than maturity_at when both are set")]
    RecoveryBeforeMaturity,
    #[msg("Draw would exceed the financier's committed standby cap.")]
    CreditWouldExceedStandbyCap,
    #[msg("Withdrawal would violate the credit pin (borrowed amount is reserved).")]
    WithdrawalWouldViolatePin,
    #[msg("Borrow recovery deadline has not passed yet.")]
    BorrowRecoveryTooEarly,
    #[msg("No standby backer is configured for this vault.")]
    NoStandbyBacker,
    #[msg("Nothing is borrowed on this vault.")]
    NothingBorrowed,
}
