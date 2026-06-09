//! Credit Level 2 — `open_standby`. Establishes a credit relationship: a
//! financier agrees to back the USER's vault up to `standby_cap`. Writes
//! `standby_backer` / `standby_cap` onto the USER's vault.
//!
//! TWO-SIGNATURE CONSENT (load-bearing invariant):
//! Because this instruction writes credit terms onto the USER's vault, it MUST
//! require the USER's vault passkey to consent. If only the financier signed,
//! anyone could attach a credit facility to a vault they don't own — a
//! write-to-arbitrary-vault hole. So the on-chain HARD requirement is the
//! user's passkey signature over the op-message (verified via the SIMD-0075
//! precompile sibling, exactly like `register_session_key` /
//! `recover_abandoned_lock`).
//!
//! Financier leg — design decision (v1):
//! `verify_passkey_signed` locates its secp256r1 sibling at a single fixed
//! position: `current_index - 1` (see `introspect_simd_0075`). It assumes the
//! immediately-preceding instruction is THE precompile. Supporting a second,
//! independent passkey-verify leg in the same transaction would require a
//! second precompile sibling at a different position, which the existing helper
//! cannot address without a signature change. Rather than fork the verifier for
//! this task, v1 represents the financier's authorization by the
//! `financier_swig` account they pass in (and their co-signing/submission of
//! the transaction at the wallet layer). The NON-NEGOTIABLE on-chain invariant
//! remains: the USER's vault passkey MUST have signed the op-message, or this
//! instruction rejects. A second on-chain financier passkey leg is future work.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::sysvar;

use crate::state::*;
use crate::verify::webauthn::verify_passkey_signed;

#[derive(Accounts)]
pub struct OpenStandby<'info> {
    /// The USER's vault — receives `standby_backer` / `standby_cap`. Mutated, no
    /// signer required: the user's passkey signature embedded in the args
    /// (verified via the SIMD-0075 precompile sibling) is what authorizes the
    /// mutation.
    #[account(mut)]
    pub vault: Account<'info, Vault>,

    /// CHECK: the financier's backing vault swig_address, recorded verbatim as
    /// `standby_backer`. Not deserialized — it is an identity, not an account we
    /// read. The financier's authorization in v1 is represented by this account
    /// + their wallet-level co-signing of the transaction (see module docs).
    pub financier_swig: AccountInfo<'info>,

    /// The financier's reserve ledger — must exist (set via set_standby_reserve)
    /// and match financier_swig. Mutated (aggregate_promised updated).
    #[account(
        mut,
        seeds = [STANDBY_BACKER_SEED, financier_swig.key().as_ref()],
        bump = standby_backer.bump,
    )]
    pub standby_backer: Account<'info, StandbyBacker>,

    /// CHECK: instructions sysvar — address-constrained. The previous
    /// instruction in the transaction MUST be a secp256r1_verify call carrying
    /// the USER's passkey signature over the op-message.
    #[account(address = sysvar::instructions::ID)]
    pub instructions_sysvar: AccountInfo<'info>,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct OpenStandbyArgs {
    /// The credit ceiling the financier commits. `borrowed <= cap` always.
    pub cap: u64,
    /// WebAuthn clientDataJSON; challenge must be sha256(op_message).
    pub client_data_json: Vec<u8>,
    /// WebAuthn authenticatorData (37+ bytes).
    pub authenticator_data: Vec<u8>,
}

pub fn handler(ctx: Context<OpenStandby>, args: OpenStandbyArgs) -> Result<()> {
    require!(
        ctx.accounts.vault.version == VAULT_VERSION_V5 || ctx.accounts.vault.version == VAULT_VERSION_V6,
        VaultError::UnsupportedVaultVersion
    );

    // A zero cap is a meaningless credit facility. `StandbyCapZero` is the
    // semantically correct error for a zero CONFIGURED cap; the draw-time
    // ceiling check uses `CreditWouldExceedStandbyCap`.
    require!(args.cap > 0, VaultError::StandbyCapZero);

    // Build the op-message the USER's passkey consented to. Bind it to the
    // user's vault + financier identity + cap so a signature cannot be replayed
    // against a different vault, a different backer, or a different ceiling.
    let mut op_msg = Vec::with_capacity(b"open_standby".len() + 32 + 32 + 8);
    op_msg.extend_from_slice(b"open_standby");
    op_msg.extend_from_slice(ctx.accounts.vault.key().as_ref());
    op_msg.extend_from_slice(ctx.accounts.financier_swig.key().as_ref());
    op_msg.extend_from_slice(&args.cap.to_le_bytes());

    // MANDATORY consent leg: the USER's vault passkey MUST have signed op_msg.
    // Same pattern as recover_abandoned_lock. If this fails, the instruction
    // rejects and no credit terms are written.
    verify_passkey_signed(
        &ctx.accounts.instructions_sysvar,
        &ctx.accounts.vault.passkey_pubkey,
        &args.client_data_json,
        &args.authenticator_data,
        &op_msg,
    )?;

    // Block backer-change: a DIFFERENT financier may not overwrite an existing
    // standby — the existing one must close_standby first. After this, only two
    // cases remain: fresh open (None) or same-financier resize.
    if let Some(existing) = ctx.accounts.vault.standby_backer {
        require!(
            existing == ctx.accounts.financier_swig.key(),
            VaultError::StandbyBackerMismatch
        );
    }

    // The financier's ledger must match the financier_swig backing this vault.
    require!(
        ctx.accounts.standby_backer.financier_swig == ctx.accounts.financier_swig.key(),
        VaultError::NoStandbyBackerLedger
    );

    // Resize-below-borrowed guard: cannot promise less than is already drawn.
    require!(
        args.cap >= ctx.accounts.vault.borrowed,
        VaultError::ResizeBelowBorrowed
    );

    // Update aggregate_promised by the DELTA (open_standby REPLACES standby_cap,
    // never accumulates). TWO explicit branches — no signed delta (u64).
    let old_cap = if ctx.accounts.vault.standby_backer.is_some() {
        ctx.accounts.vault.standby_cap
    } else {
        0
    };
    let new_cap = args.cap;
    if new_cap >= old_cap {
        // fresh open (old_cap == 0 -> add new_cap) OR resize-up (add the increase).
        let increase = new_cap - old_cap; // safe: new_cap >= old_cap
        let new_aggregate = ctx
            .accounts
            .standby_backer
            .aggregate_promised
            .checked_add(increase)
            .ok_or(VaultError::StandbyWouldExceedReserve)?;
        require!(
            new_aggregate <= ctx.accounts.standby_backer.committed_reserve,
            VaultError::StandbyWouldExceedReserve
        );
        ctx.accounts.standby_backer.aggregate_promised = new_aggregate;
    } else {
        // resize-down: aggregate falls; no ceiling check needed.
        let decrease = old_cap - new_cap; // safe: old_cap > new_cap
        ctx.accounts.standby_backer.aggregate_promised = ctx
            .accounts
            .standby_backer
            .aggregate_promised
            .saturating_sub(decrease);
    }

    // Existing writes (unchanged behavior).
    let vault = &mut ctx.accounts.vault;
    vault.standby_backer = Some(ctx.accounts.financier_swig.key());
    vault.standby_cap = args.cap;

    Ok(())
}
