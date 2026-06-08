//! Aggregate-reserve — set_standby_reserve. Sets/raises a financier's committed
//! reserve on their StandbyBacker ledger. This write is a financier-only mutation,
//! so it is bound DIRECTLY to the financier's swig authority (mechanism B):
//!
//! The financier consents by invoking this instruction as the INNER CPI of their
//! swig's SignV2. Swig signs that inner CPI with the financier's swig_wallet PDA
//! (invoke_signed). We REQUIRE that swig_wallet PDA to be a signer here, and we
//! PDA-constrain it to [SWIG_WALLET_ADDRESS_SEED, financier_swig] — so the only
//! way to produce this signature is through the financier's own swig authority.
//! Omit the SignV2 → no swig_wallet signature → this instruction reverts. The
//! effect (the reserve write) is thus bound to the consent, on THIS exact call.
//!
//! No ProgramExec marker, no instructions-sysvar adjacency, no following-sibling
//! introspection. Adjacency (a sibling SignV2 merely EXISTING) was the prior
//! vacuous-consent bug — it never gated whether this write ran. The signer
//! requirement does.
//!
//! FIREWALL: financier_swig is AccountInfo (identity), never deserialized.

use anchor_lang::prelude::*;

use crate::constants::{SWIG_PROGRAM_ID, SWIG_WALLET_ADDRESS_SEED};
use crate::state::*;

#[derive(Accounts)]
pub struct SetStandbyReserve<'info> {
    /// The FINANCIER's swig (identity + authority). It is the seed source for
    /// standby_backer and for the swig_wallet PDA below.
    /// CHECK: identity-only; never deserialized (the firewall).
    pub financier_swig: AccountInfo<'info>,

    /// The financier's swig_wallet PDA. A SIGNER: this instruction runs ONLY as
    /// the inner CPI of the financier's swig SignV2, which signs with this PDA
    /// (Swig invoke_signed). PDA-constrained so we KNOW the signer is the
    /// financier's swig_wallet — that derivation + the signature together ARE the
    /// financier's consent, bound to THIS exact call (mechanism B). No marker, no
    /// sysvar adjacency.
    #[account(
        seeds = [SWIG_WALLET_ADDRESS_SEED, financier_swig.key().as_ref()],
        bump,
        seeds::program = SWIG_PROGRAM_ID,
    )]
    pub financier_swig_wallet_address: Signer<'info>,

    /// The financier's reserve ledger. Init on first call, mutated thereafter.
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

    pub system_program: Program<'info, System>,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct SetStandbyReserveArgs {
    /// The committed reserve ceiling to set. Must be >= current aggregate_promised.
    pub new_reserve: u64,
}

pub fn handler(ctx: Context<SetStandbyReserve>, args: SetStandbyReserveArgs) -> Result<()> {
    let standby_backer = &mut ctx.accounts.standby_backer;

    // First-call init. init_if_needed is safe here despite its re-init footgun:
    // (1) the PDA is seeded by [STANDBY_BACKER_SEED, financier_swig], so the
    //     account address is DETERMINISTIC per financier — an attacker cannot
    //     substitute a different account at this seed.
    // (2) this `version == 0` guard runs the init body ONLY on a freshly-created
    //     (zeroed) account. An already-initialized ledger has version == 1, so a
    //     second call SKIPS this block entirely — financier_swig and
    //     aggregate_promised are NEVER reset on a live ledger (no lost-promises).
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

    // Financier consent is enforced structurally: financier_swig_wallet_address is
    // a PDA-constrained Signer. This instruction can only execute as the inner CPI
    // of the financier's swig SignV2, which signs with that swig_wallet PDA
    // (invoke_signed). No swig authority → no signature → Anchor reverts before we
    // get here (with its generic ConstraintSigner / missing-signature error, NOT a
    // custom VaultError — the Signer constraint fires pre-handler). The write above
    // is therefore bound to the financier's consent on THIS exact call (mechanism
    // B). The VaultError::FinancierConsentMissing variant documents this same
    // consent rule for close_standby's financier leg, which checks is_signer
    // explicitly in-handler (its struct can't be a Signer — the user leg shares it).
    Ok(())
}
