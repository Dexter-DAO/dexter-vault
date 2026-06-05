//! Settle a Tab voucher on-chain.
//!
//! This is the missing piece that turns a session-signed off-chain voucher
//! into an actual USDC transfer from the buyer's swig wallet PDA's ATA to
//! the seller's ATA. It's the on-chain twin of `tab.close()` in the
//! `@dexterai/x402/tab` SDK — without it, the SDK returns `settleTx: ''`
//! because no instruction existed that knew how to consume a Tab voucher.
//!
//! Transaction shape (three instructions, atomic):
//!
//!   [N-1]  Ed25519SigVerify precompile
//!            data = pubkey || signature || message
//!            where message = channel_id(32) || cumulative_amount u64-LE ||
//!                            sequence_number u32-LE  (44 bytes)
//!   [N  ]  vault::settle_tab_voucher  ← this instruction
//!            validates the precompile sibling matches
//!            (session_pubkey, voucher_message), then validates against the
//!            session state stored on the vault, decrements
//!            pending_voucher_count, and updates `spent`. Account[0..1] are
//!            [swig, swig_wallet] — required by Swig's ProgramExec validator
//!            for the NEXT instruction.
//!   [N+1]  swig::SignV2(TransferChecked)
//!            Swig validates accounts[0..1] of THIS instruction equal
//!            accounts[0..1] of the preceding ix ([swig, swig_wallet]) AND
//!            that the preceding instruction's data starts with the
//!            settle_tab_voucher discriminator (registered as a ProgramExec
//!            marker at Swig creation in swigBundle.ts). On match, executes
//!            the SPL transfer from swig_wallet_ata → seller_ata signed by
//!            the swig wallet PDA, as a ProgramExec authority.
//!
//! New Swigs created after the swigBundle.ts marker-list update register
//! BOTH `finalize_withdrawal` and `settle_tab_voucher` discriminators as
//! accepted ProgramExec markers. Old Swigs (registered with only the
//! finalize_withdrawal marker) cannot use this instruction — they're a
//! legacy class. The unruggable-channel property under this model is
//! structurally enforced on-chain: the master key is never in the spend
//! path; only the vault program (validating the session signature) can
//! authorize the Swig transfer.
//!
//! Security properties this delivers:
//!   - Buyer's funds never leave the swig wallet PDA until the cumulative
//!     amount has been validated against an off-chain Ed25519 signature by
//!     the session key registered on the vault.
//!   - Replay impossible: each settle bumps `vault.active_session.spent`
//!     monotonically; a stale voucher with a smaller cumulative is rejected.
//!   - Over-spend impossible: `cumulative <= session.max_amount` checked.
//!   - Expiry enforced: `now < session.expires_at`.
//!   - Counterparty bound: the voucher's seller must match the seller
//!     who's about to be paid by the Swig CPI (validated via account
//!     ordering — the buyer's SDK constructs the voucher with the seller
//!     it's actually paying).
//!
//! What the dexter_authority gains: nothing the buyer didn't already
//! authorize. The dexter_authority signs the SOL fees and is recorded on
//! the vault's `pending_voucher_count` decrement, but the spend itself is
//! gated entirely by the session-key signature the buyer's SDK produced.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::sysvar;

use crate::constants::{SWIG_PROGRAM_ID, SWIG_WALLET_ADDRESS_SEED};
use crate::state::*;
use crate::verify::ed25519::verify_session_signed;

#[derive(Accounts)]
pub struct SettleTabVoucher<'info> {
    /// Position 0 — REQUIRED at this index by Swig's ProgramExec authority
    /// validator. When a Swig::SignV2 follows this instruction in the same
    /// transaction, Swig's on-chain validator inspects accounts[0..1] of
    /// the preceding instruction and rejects unless they're
    /// [swig, swig_wallet], AND that the preceding instruction's data
    /// starts with a registered marker discriminator.
    ///
    /// Also bound to `vault.swig_address` via the Anchor `address`
    /// constraint, so a caller cannot pass an arbitrary Swig account here.
    ///
    /// CHECK: address constraint binds it to vault.swig_address; we never
    /// deserialize or dereference it.
    #[account(address = vault.swig_address)]
    pub swig: AccountInfo<'info>,

    /// Position 1 — required by Swig's ProgramExec validator (see `swig`).
    /// The Swig wallet address is the PDA owning the SPL token ATA being
    /// debited; derived under the Swig program at
    /// `["swig-wallet-address", swig_pubkey]`.
    ///
    /// CHECK: PDA constraint validates derivation; not deserialized.
    #[account(
        seeds = [SWIG_WALLET_ADDRESS_SEED, swig.key().as_ref()],
        bump,
        seeds::program = SWIG_PROGRAM_ID,
    )]
    pub swig_wallet_address: AccountInfo<'info>,

    #[account(
        mut,
        has_one = dexter_authority @ VaultError::PasskeyVerificationFailed,
    )]
    pub vault: Account<'info, Vault>,

    /// Must equal `vault.dexter_authority` — only the recorded authority
    /// can drive the gate-counter decrement. The buyer's session-key
    /// signature is what authorizes the SPEND amount; this signer is what
    /// authorizes the counter mutation. Same model as the existing
    /// `settle_voucher`. NOTE: this signer does NOT sign the Swig transfer
    /// in [N+1] — that's signed by the swig wallet PDA via Swig's
    /// ProgramExec authority, gated by the vault program being the
    /// ProgramExec authority on the Swig.
    pub dexter_authority: Signer<'info>,

    /// CHECK: instructions sysvar — address-constrained.
    #[account(address = sysvar::instructions::ID)]
    pub instructions_sysvar: AccountInfo<'info>,
}

#[derive(AnchorSerialize, AnchorDeserialize)]
pub struct SettleTabVoucherArgs {
    /// Channel id from the voucher's payload — first 32 bytes of the
    /// 44-byte message the session key signed.
    pub channel_id: [u8; 32],

    /// Total cumulative amount this voucher authorizes. Must be > the
    /// vault's recorded `active_session.spent` (monotonic) and <= the
    /// session's `max_amount` cap.
    pub cumulative_amount: u64,

    /// Monotonic sequence number from the voucher payload. Stored as-is in
    /// the signed message; not currently used for replay defense (the
    /// `spent` monotonicity check covers replay) but reserved for future
    /// out-of-order voucher detection.
    pub sequence_number: u32,
}

pub fn handler(ctx: Context<SettleTabVoucher>, args: SettleTabVoucherArgs) -> Result<()> {
    let vault = &mut ctx.accounts.vault;

    require!(
        vault.version == VAULT_VERSION_V4 || vault.version == VAULT_VERSION_V3 || vault.version == VAULT_VERSION_V2,
        VaultError::UnsupportedVaultVersion
    );
    require!(
        vault.swig_address != Pubkey::default(),
        VaultError::PasskeyVerificationFailed
    );

    // The vault must have an active session — that's what we're settling
    // against. revoke_session_key clears it, registration replaces it; both
    // are passkey-signed, so the only way active_session is None or stale
    // here is if the buyer explicitly cleared it.
    let session = vault
        .active_session
        .as_ref()
        .ok_or(VaultError::NoActiveSession)?
        .clone();

    let now = Clock::get()?.unix_timestamp;
    require!(now < session.expires_at, VaultError::SessionExpiryInPast);

    require!(
        args.cumulative_amount > session.spent,
        VaultError::InvalidVoucherSignature
    );
    require!(
        args.cumulative_amount <= session.max_amount,
        VaultError::InvalidVoucherSignature
    );

    // Reconstruct the 44-byte canonical voucher message the SDK signed
    // (see dexter-x402-sdk/src/tab/messages.ts::voucherPayloadMessage).
    let mut voucher_message = Vec::with_capacity(44);
    voucher_message.extend_from_slice(&args.channel_id);
    voucher_message.extend_from_slice(&args.cumulative_amount.to_le_bytes());
    voucher_message.extend_from_slice(&args.sequence_number.to_le_bytes());

    // Confirms the preceding instruction was an Ed25519 precompile call
    // verifying THIS pubkey signed THIS message. The precompile already
    // checked the signature itself.
    verify_session_signed(
        &ctx.accounts.instructions_sysvar,
        &session.session_pubkey,
        &voucher_message,
    )?;

    // The actual increment over what's already been settled — this is what
    // the following Swig::SignV2 transfer will move.
    let increment = args
        .cumulative_amount
        .checked_sub(session.spent)
        .ok_or(VaultError::InvalidVoucherSignature)?;

    // Mutate the active session in place.
    if let Some(active) = vault.active_session.as_mut() {
        active.spent = args.cumulative_amount;
        // Release exposure: the credex meter's FALL seam. `increment` is the
        // USDC actually moving in THIS settle (atomic with the Swig transfer
        // that follows), so capacity frees only against money that really
        // settled. saturating_sub guards a stranded settle (no prior open).
        active.current_outstanding = active.current_outstanding.saturating_sub(increment);
    }

    // Decrement the gate counter. The MppSession path's
    // `pending_voucher_count` discipline applies here too: a tab open
    // incremented it (via vaultPendingVoucher.ts in the facilitator);
    // settling brings it back to zero. We saturate to be safe but expect
    // the count to be > 0 — if it's already zero, this is a stranded
    // settle (no open exists to balance) and we still allow it because
    // the session-key signature is sufficient authorization.
    vault.pending_voucher_count = vault.pending_voucher_count.saturating_sub(1);

    Ok(())
}
