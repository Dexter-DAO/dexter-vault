//! Aggregate-reserve — set_standby_reserve. Sets/raises a financier's committed
//! reserve on their StandbyBacker ledger. Financier consent is proven via the
//! financier's SWIG AUTHORITY: a paired [N+1] swig::SignV2 (zero-transfer payload)
//! whose ProgramExec marker is THIS instruction's discriminator on the FINANCIER's
//! swig — the same mechanism draw_credit uses, with no money moved. NO passkey:
//! the financier never consents via passkey.
//!
//! Transaction shape (two top-level siblings, atomic):
//!   [N]   vault::set_standby_reserve  ← this instruction (validates, sets reserve;
//!           confirms a SignV2 follows). NO USDC moves here.
//!   [N+1] swig::SignV2(<zero-transfer payload, empty Vec<Instruction> => [0x00]>)
//!           Swig validates the PRECEDING ix data carries the set_standby_reserve
//!           discriminator (ProgramExec marker on the FINANCIER's swig) and
//!           authenticates the financier authority. Non-replayable to a draw
//!           (different discriminator).
//!
//! Self-validation division (mirrors draw_credit exactly): this HANDLER does NOT
//! introspect the following SignV2 itself. draw_credit's handler performs no
//! manual instructions-sysvar parse of the next instruction — it relies purely on
//! the account-position constraints (financier_swig at index 0 and
//! financier_swig_wallet_address at index 1 — the fixed offsets Swig's ProgramExec
//! validator reads, the latter PDA-constrained; instructions_sysvar
//! address-constrained) plus Swig's own validator to enforce
//! the marker + authority. We mirror that: this handler only validates account
//! shape + mutates ledger state.
//!
//! FIREWALL: financier_swig is AccountInfo (identity), never deserialized.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::sysvar;

use crate::constants::{SWIG_PROGRAM_ID, SWIG_WALLET_ADDRESS_SEED};
use crate::state::*;

#[derive(Accounts)]
pub struct SetStandbyReserve<'info> {
    /// Position 0 — required at this index by Swig's ProgramExec validator on the
    /// following SignV2 (the validator hard-codes config_account_index = 0 and
    /// reads get_account_meta_at_unchecked(0), asserting it equals the financier
    /// swig). The FINANCIER's swig (identity + authority). It is the seed source
    /// for standby_backer.
    /// CHECK: identity-only; never deserialized (the firewall).
    pub financier_swig: AccountInfo<'info>,

    /// Position 1 — required at this index by Swig's ProgramExec validator (the
    /// validator hard-codes wallet_account_index = 1 and reads
    /// get_account_meta_at_unchecked(1), asserting it equals the swig wallet).
    /// Derives from the financier's swig (mirrors draw_credit).
    /// CHECK: PDA constraint validates derivation; never deref.
    #[account(
        seeds = [SWIG_WALLET_ADDRESS_SEED, financier_swig.key().as_ref()],
        bump,
        seeds::program = SWIG_PROGRAM_ID,
    )]
    pub financier_swig_wallet_address: AccountInfo<'info>,

    /// The financier's reserve ledger. Init on first call, mutated thereafter.
    /// Its seeds/init work regardless of struct position; it MUST come after the
    /// two ProgramExec-fixed accounts above so financier_swig stays at index 0.
    #[account(
        init_if_needed,
        payer = fee_payer,
        space = 8 + StandbyBacker::INIT_SPACE,
        seeds = [STANDBY_BACKER_SEED, financier_swig.key().as_ref()],
        bump,
    )]
    pub standby_backer: Account<'info, StandbyBacker>,

    #[account(mut)]
    pub fee_payer: Signer<'info>,

    /// CHECK: instructions sysvar — address-constrained. The FOLLOWING instruction
    /// is the swig::SignV2 that introspects this one (proves financier authority).
    #[account(address = sysvar::instructions::ID)]
    pub instructions_sysvar: AccountInfo<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct SetStandbyReserveArgs {
    /// The committed reserve ceiling to set. Must be >= current aggregate_promised.
    pub new_reserve: u64,
}

pub fn handler(ctx: Context<SetStandbyReserve>, args: SetStandbyReserveArgs) -> Result<()> {
    let standby_backer = &mut ctx.accounts.standby_backer;

    // Init on first call (version == 0 means freshly created by init_if_needed).
    if standby_backer.version == 0 {
        standby_backer.version = STANDBY_BACKER_VERSION_V1;
        standby_backer.bump = ctx.bumps.standby_backer;
        standby_backer.financier_swig = ctx.accounts.financier_swig.key();
        standby_backer.aggregate_promised = 0;
        standby_backer.reserve_kind = ReserveKind::Declared;
    }

    // Lowering guard: cannot un-commit reserve already promised against.
    require!(
        args.new_reserve >= standby_backer.aggregate_promised,
        VaultError::ReserveBelowPromised
    );

    standby_backer.committed_reserve = args.new_reserve;

    // Financier consent = the paired [N+1] swig::SignV2 authority proof (the
    // set_standby_reserve discriminator as a ProgramExec marker on the financier's
    // swig). Swig authenticates the financier authority and validates the marker
    // against THIS preceding instruction; the instructions_sysvar address
    // constraint + the financier_swig/wallet account positions are what this
    // instruction asserts. The zero-transfer payload moves nothing.
    Ok(())
}
