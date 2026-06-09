//! Crystallize a session-signed voucher into a vault-level LockedClaim PDA.
//!
//! `lock_voucher` is the graduation seam between the session-revocable
//! exposure tier (current_outstanding) and the vault-crystallized
//! reservation tier (outstanding_locked_amount). It performs the atomic
//! three-field mutation specified in seam spec §2:
//!
//!   session.current_outstanding   -= D    (saturating_sub)
//!   session.crystallized_cumulative += D
//!   vault.outstanding_locked_amount += D
//!
//! where D = voucher.cumulative_amount - session.crystallized_cumulative.
//!
//! Transaction shape (two instructions, atomic):
//!
//!   [N-1]  Ed25519SigVerify precompile
//!            data = pubkey || signature || message
//!            where message = channel_id(32) || cumulative_amount u64-LE ||
//!                            sequence_number u32-LE  (44 bytes)
//!   [N  ]  vault::lock_voucher  ← this instruction
//!            validates the precompile sibling matches
//!            (session_pubkey, voucher_message), applies the frontier
//!            guard, computes D, performs the graduation, creates the
//!            LockedClaim PDA in pending status. NO USDC moves — funds
//!            stay in the swig wallet ATA until settle_locked_voucher.
//!
//! Security properties this delivers (matching seam spec §4):
//!   - The XOR frontier guard `cumulative_amount > max(spent,
//!     crystallized_cumulative)` blocks any cumulative range already
//!     covered by either terminal odometer. Replay impossible; XOR
//!     enforced.
//!   - The vault-balance self-check (V0.3 Decision 1) blocks any lock
//!     that would push outstanding_locked_amount above the live USDC
//!     ATA balance.
//!   - The `holder_recovery_at > maturity_at` invariant (V0.3 Decision 4)
//!     prevents the catastrophic race where the buyer could recover
//!     before the holder's maturity-bound settlement window opens.
//!   - The claim PDA derivation `["locked-claim", vault_pda, voucher_hash]`
//!     gives every unique voucher a unique on-chain address, blocking
//!     double-creation.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::sysvar;
use anchor_spl::token::TokenAccount;
use solana_sha256_hasher::hashv;

use crate::constants::{SWIG_PROGRAM_ID, SWIG_WALLET_ADDRESS_SEED};
use crate::state::*;
use crate::verify::ed25519::verify_session_signed;

#[derive(Accounts)]
#[instruction(args: LockVoucherArgs)]
pub struct LockVoucher<'info> {
    #[account(
        mut,
        has_one = dexter_authority @ VaultError::PasskeyVerificationFailed,
    )]
    pub vault: Account<'info, Vault>,

    /// The swig wallet's USDC ATA — read to enforce the vault-balance
    /// self-check per V0.3 Decision 1. The handler cross-checks that this
    /// token account's `owner` field equals the canonical swig wallet PDA
    /// derived below so a caller cannot pass an unrelated funded ATA.
    pub vault_usdc_ata: Account<'info, TokenAccount>,

    /// CHECK: address constraint binds to vault.swig_address; never deref.
    #[account(address = vault.swig_address)]
    pub swig: AccountInfo<'info>,

    /// CHECK: PDA constraint validates derivation; never deref.
    #[account(
        seeds = [SWIG_WALLET_ADDRESS_SEED, swig.key().as_ref()],
        bump,
        seeds::program = SWIG_PROGRAM_ID,
    )]
    pub swig_wallet_address: AccountInfo<'info>,

    /// V6: the per-counterparty SessionAccount PDA whose meter graduates. The
    /// session moved OUT of `vault.active_session` into this PDA at
    /// `[SESSION_SEED, vault, allowed_counterparty]`. `mut` — the graduation
    /// mutates `current_outstanding`, `crystallized_cumulative`, and
    /// `last_locked_sequence` in place.
    #[account(
        mut,
        seeds = [crate::constants::SESSION_SEED, vault.key().as_ref(), args.allowed_counterparty.as_ref()],
        bump = session.bump,
    )]
    pub session: Account<'info, SessionAccount>,

    /// Claim PDA created in this instruction.
    #[account(
        init,
        payer = payer,
        space = 8 + LockedClaim::INIT_SPACE,
        seeds = [LOCKED_CLAIM_SEED, vault.key().as_ref(), &args.voucher_hash],
        bump,
    )]
    pub claim: Account<'info, LockedClaim>,

    /// Holder at creation — the seller who collected the voucher.
    pub seller_holder: Signer<'info>,

    /// Fee gate (matches settle_tab_voucher's discipline). Recorded on the
    /// vault at init; only this key authorizes the accumulator mutation.
    pub dexter_authority: Signer<'info>,

    /// Pays rent for the claim PDA. May be dexter_authority, may be a
    /// separate funder. Not security-load-bearing.
    #[account(mut)]
    pub payer: Signer<'info>,

    pub system_program: Program<'info, System>,

    /// CHECK: instructions sysvar — address-constrained.
    #[account(address = sysvar::instructions::ID)]
    pub instructions_sysvar: AccountInfo<'info>,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct LockVoucherArgs {
    /// Channel id from the voucher payload (first 32 bytes of the 44-byte
    /// signed message).
    pub channel_id: [u8; 32],
    /// Voucher's cumulative amount. Must strictly exceed the XOR frontier
    /// `max(session.spent, session.crystallized_cumulative)`.
    pub cumulative_amount: u64,
    /// Sequence number from the voucher payload. Updates
    /// `session.last_locked_sequence` but is NOT load-bearing for replay
    /// defense (the frontier guard is).
    pub sequence_number: u32,
    /// sha256(voucher_message) — used as the third PDA seed for the claim.
    /// The handler verifies this matches the actually-signed message before
    /// trusting it as a seed.
    pub voucher_hash: [u8; 32],
    /// Optional settlement maturity. If set, settle_locked_voucher rejects
    /// before this time.
    pub maturity_at: Option<i64>,
    /// Optional buyer-recovery deadline. If set with `maturity_at`, the
    /// handler enforces `holder_recovery_at > maturity_at` per V0.3
    /// Decision 4.
    pub holder_recovery_at: Option<i64>,
    /// V6: the seller this voucher's session is bound to — equals the session
    /// PDA's `allowed_counterparty`. Carried in the args so the accounts
    /// struct can re-derive the session PDA seed. Not part of the signed
    /// voucher message (layout unchanged); the seed binding ties the lock to
    /// the correct session.
    pub allowed_counterparty: Pubkey,
}

pub fn handler(ctx: Context<LockVoucher>, args: LockVoucherArgs) -> Result<()> {
    require!(
        ctx.accounts.vault.version == VAULT_VERSION_V6,
        VaultError::UnsupportedVaultVersion
    );
    require!(
        ctx.accounts.vault.swig_address != Pubkey::default(),
        VaultError::PasskeyVerificationFailed
    );

    // V0.3 Decision 4: when both timestamps set, recovery must strictly
    // follow maturity. Strict inequality prevents same-second race.
    if let (Some(maturity), Some(recovery)) = (args.maturity_at, args.holder_recovery_at) {
        require!(recovery > maturity, VaultError::RecoveryBeforeMaturity);
    }

    // V0.3 Decision 1: the vault_usdc_ata must be owned by the swig wallet
    // PDA. The Anchor PDA constraint validates `swig_wallet_address`; here
    // we cross-check the SPL token account's `owner` field matches it so a
    // caller can't pass a funded but unrelated ATA to fool the self-check.
    require!(
        ctx.accounts.vault_usdc_ata.owner == ctx.accounts.swig_wallet_address.key(),
        VaultError::PasskeyVerificationFailed
    );

    // The named session PDA must be live/registered (V6 replacement for the
    // old `vault.active_session.is_some()` check). version==0 means cleared or
    // never touched — locking against a dormant session is rejected.
    require!(
        ctx.accounts.session.version != 0,
        VaultError::NoActiveSession
    );

    // Snapshot the SessionRegistration for the read-only guards / verify. The
    // graduation mutation later takes a fresh &mut on the same account.
    let session = ctx.accounts.session.session.clone();

    let now = Clock::get()?.unix_timestamp;
    require!(now < session.expires_at, VaultError::SessionExpiryInPast);

    // XOR frontier guard (seam spec §4). Symmetric to the same guard added
    // to settle_tab_voucher in Task 2. A voucher whose cumulative range was
    // already covered by EITHER terminal odometer (spent OR
    // crystallized_cumulative) is rejected here, regardless of which path
    // covered it. This single line enforces XOR.
    let frontier = session.spent.max(session.crystallized_cumulative);
    require!(
        args.cumulative_amount > frontier,
        VaultError::LockRangeAlreadyClaimed
    );
    require!(
        args.cumulative_amount <= session.max_amount,
        VaultError::InvalidVoucherSignature
    );

    // Reconstruct the canonical 44-byte voucher message
    // (channel_id || cumulative_amount u64-LE || sequence_number u32-LE),
    // matching settle_tab_voucher.rs and the SDK's
    // voucherPayloadMessage helper.
    let mut voucher_message = Vec::with_capacity(44);
    voucher_message.extend_from_slice(&args.channel_id);
    voucher_message.extend_from_slice(&args.cumulative_amount.to_le_bytes());
    voucher_message.extend_from_slice(&args.sequence_number.to_le_bytes());

    // Confirm the preceding instruction was an Ed25519 precompile call
    // verifying this session_pubkey signed this message.
    verify_session_signed(
        &ctx.accounts.instructions_sysvar,
        &session.session_pubkey,
        &voucher_message,
    )?;

    // Verify the caller's claimed voucher_hash matches the actual hash.
    // The hash is a PDA seed; if the caller lied about it, the PDA address
    // wouldn't have validated, but we belt-and-suspenders the message bytes.
    let computed_hash = hashv(&[&voucher_message]);
    require!(
        computed_hash.as_ref() == args.voucher_hash,
        VaultError::InvalidVoucherSignature
    );

    // Delta is what graduates from the session-revocable tier to the
    // vault-crystallized tier. Per seam spec §2:
    //   D = voucher.cumulative_amount - session.crystallized_cumulative
    let delta = args
        .cumulative_amount
        .checked_sub(session.crystallized_cumulative)
        .ok_or(VaultError::LockRangeAlreadyClaimed)?;
    require!(delta > 0, VaultError::LockRangeAlreadyClaimed);

    // V0.3 Decision 1 self-check: the post-lock outstanding must not exceed
    // the live USDC balance. vault_usdc_ata.amount is read live from the
    // SPL token account — never a cached field.
    let proposed_outstanding = ctx
        .accounts
        .vault
        .outstanding_locked_amount
        .checked_add(delta)
        .ok_or(VaultError::LockWouldOvercommitVault)?;
    require!(
        proposed_outstanding <= ctx.accounts.vault_usdc_ata.amount,
        VaultError::LockWouldOvercommitVault
    );

    // ── The graduation (seam spec §2). Atomic mutation of three fields. ──
    // V6: the session-tier fields live on the PDA now. The Option is gone —
    // the PDA exists (seed constraint) and is live (version guard above), so
    // this is unconditional. Metering math UNCHANGED.
    {
        let active = &mut ctx.accounts.session.session;
        // Session-revocable tier falls. saturating_sub matches the
        // settle_tab_voucher precedent at line ~212: a stranded lock
        // (current_outstanding < delta) clamps to zero instead of
        // underflowing. The vault-tier increment still applies the full
        // delta because the claim against vault USDC is independent of
        // what the session meter was holding.
        active.current_outstanding = active.current_outstanding.saturating_sub(delta);
        active.crystallized_cumulative = active.crystallized_cumulative.saturating_add(delta);
        active.last_locked_sequence = args.sequence_number;
    }

    // Vault-tier writes (separate &mut borrow; different account).
    let vault_key = ctx.accounts.vault.key();
    {
        let vault = &mut ctx.accounts.vault;
        vault.outstanding_locked_amount = proposed_outstanding;
        vault.total_crystallized_amount = vault
            .total_crystallized_amount
            .saturating_add(delta);
    }

    // Create the LockedClaim PDA in pending state per V0.3 Decision 6.
    let claim = &mut ctx.accounts.claim;
    claim.version = LOCKED_CLAIM_VERSION_V1;
    claim.bump = ctx.bumps.claim;
    claim.vault = vault_key;
    claim.session_pubkey_at_lock = session.session_pubkey;
    claim.voucher_hash = args.voucher_hash;
    claim.amount = delta;
    claim.created_at = now;
    claim.maturity_at = args.maturity_at;
    claim.holder_recovery_at = args.holder_recovery_at;
    claim.current_holder = ctx.accounts.seller_holder.key();
    claim.status = LockedClaimStatus::Pending;
    claim.settled_at = None;
    claim.recovered_at = None;

    Ok(())
}
