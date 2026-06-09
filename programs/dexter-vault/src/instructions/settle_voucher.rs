use anchor_lang::prelude::*;

use crate::state::*;

#[derive(Accounts)]
#[instruction(args: SettleVoucherArgs)]
pub struct SettleVoucher<'info> {
    #[account(mut, has_one = dexter_authority @ VaultError::PasskeyVerificationFailed)]
    pub vault: Account<'info, Vault>,
    /// Must equal the `dexter_authority` recorded on the vault at init.
    /// `has_one` enforces this — closing Finding B (previously any signer
    /// could mutate the counter).
    pub dexter_authority: Signer<'info>,
    /// V6: the per-counterparty SessionAccount PDA whose revolving meter rises
    /// at tab-open. OPTIONAL because only the `increment == true` (tab-open)
    /// path touches a session — the `increment == false` (close) path is a
    /// bare `pending_voucher_count` decrement that never reads a session, so a
    /// caller closing a counter need not pass one. When present, the seed binds
    /// it to (vault, allowed_counterparty); `mut` because the RISE seam writes
    /// `current_outstanding`. The handler REQUIRES `Some(live)` on the
    /// increment path (you cannot raise a meter that isn't there).
    #[account(
        mut,
        seeds = [crate::constants::SESSION_SEED, vault.key().as_ref(), args.allowed_counterparty.as_ref()],
        bump = session.bump,
    )]
    pub session: Option<Account<'info, SessionAccount>>,
}

#[derive(AnchorSerialize, AnchorDeserialize)]
pub struct SettleVoucherArgs {
    pub amount: u64,
    pub increment: bool,
    /// V6: the seller the tab is opened against — equals the session PDA's
    /// `allowed_counterparty`. Carried so the accounts struct can re-derive the
    /// (optional) session PDA seed. Only load-bearing on the increment path; on
    /// the close path it's ignored (no session account is passed).
    pub allowed_counterparty: Pubkey,
}

pub fn handler(ctx: Context<SettleVoucher>, args: SettleVoucherArgs) -> Result<()> {
    require!(
        ctx.accounts.vault.version == VAULT_VERSION_V6,
        VaultError::UnsupportedVaultVersion
    );
    if args.increment {
        // Bump the gate counter (separate &mut borrow; different account).
        // Order preserved from V4 (counter first, then meter); the whole
        // instruction is atomic, so a capacity reject below reverts this too.
        {
            let vault = &mut ctx.accounts.vault;
            vault.pending_voucher_count = vault.pending_voucher_count.saturating_add(1);
        }
        // Capture exposure: the credex meter's RISE seam. In V6 the session is
        // required on this path: you cannot raise a revolving meter that isn't
        // there. (V4 silently skipped when active_session was None; V6's
        // per-counterparty PDA makes the meter explicit, so absence is an
        // error rather than a meter-bypass.) The amount the facilitator passes
        // at tab-open raises live outstanding exposure, admission-capped by the
        // session's max_revolving_capacity. Math UNCHANGED.
        let session = ctx
            .accounts
            .session
            .as_mut()
            .ok_or(VaultError::NoActiveSession)?;
        require!(session.version != 0, VaultError::NoActiveSession);
        let s = &mut session.session;
        let new_outstanding = s
            .current_outstanding
            .checked_add(args.amount)
            .ok_or(VaultError::RevolvingCapacityExceeded)?;
        require!(
            new_outstanding <= s.max_revolving_capacity,
            VaultError::RevolvingCapacityExceeded
        );
        s.current_outstanding = new_outstanding;
    } else {
        let vault = &mut ctx.accounts.vault;
        require!(vault.pending_voucher_count > 0, VaultError::NoPendingWithdrawal);
        vault.pending_voucher_count -= 1;
        // No meter change here: the bare-counter decrement is the non-value
        // close marker. Real exposure release happens in settle_tab_voucher
        // (atomic with the USDC transfer).
    }
    Ok(())
}
