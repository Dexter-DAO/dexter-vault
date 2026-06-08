//! Credit Level 2 — `close_standby`. THE RELEASE. Tears down a vault's standby
//! credit relationship: clears `standby_backer` / `standby_cap` on the USER's
//! vault AND decrements the financier's `aggregate_promised` on their
//! StandbyBacker ledger by this vault's cap. Callable by EITHER party:
//!   - the USER (passkey consent over an op-message), or
//!   - the FINANCIER (swig-authority consent via a paired [N+1] swig::SignV2).
//! Gated on `vault.borrowed == 0` — you cannot release a standby while a loan
//! is still open against it (`StandbyStillBorrowed`).
//!
//! ── SINGLE-INSTRUCTION DESIGN (not split) ────────────────────────────────────
//! Two consent legs with conflicting-looking account-position needs share ONE
//! accounts struct, because the two needs do not actually conflict:
//!
//!   FINANCIER leg: Swig's ProgramExec validator on the following SignV2
//!     HARD-CODES config_account_index = 0 and wallet_account_index = 1. So
//!     `financier_swig` MUST be account index 0 and `financier_swig_wallet_address`
//!     index 1 (the Task 2 make-or-break lesson). draw_credit / set_standby_reserve
//!     do exactly this.
//!
//!   USER leg: needs only (a) the vault (to read passkey_pubkey + clear terms)
//!     and (b) the secp256r1 precompile sibling. `verify_passkey_signed` locates
//!     that sibling purely by reading `instructions_sysvar` at
//!     `current_index - 1` — it NEVER inspects `ctx.accounts` positions. So
//!     `financier_swig` sitting at index 0 is harmless for the user leg. The
//!     user knows the financier swig regardless — it's recorded on their vault as
//!     `standby_backer`.
//!
//! Therefore a SINGLE instruction with `financier_swig` at index 0 +
//! `financier_swig_wallet_address` at index 1 serves BOTH legs. The handler
//! branches on `args.closer`. The user leg simply has no following SignV2; the
//! financier leg does. Splitting into two instructions would duplicate the
//! account struct and the core logic for zero benefit.
//!
//! Transaction shapes:
//!   USER:
//!     [N-1] secp256r1_verify(user passkey over "close_standby"||vault||financier)
//!     [N]   vault::close_standby { closer: User }
//!   FINANCIER:
//!     [N]   vault::close_standby { closer: Financier }
//!     [N+1] swig::SignV2(<zero-transfer payload>)  ← ProgramExec marker = this
//!             instruction's discriminator on the FINANCIER's swig. No money moves.
//!
//! FIREWALL: financier_swig is AccountInfo (identity only), never deserialized.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::sysvar;

use crate::constants::{SWIG_PROGRAM_ID, SWIG_WALLET_ADDRESS_SEED};
use crate::state::*;
use crate::verify::webauthn::verify_passkey_signed;

/// Who is consenting to the close. The user leg proves a passkey signature; the
/// financier leg proves swig authority via the paired SignV2.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub enum Closer {
    User,
    Financier,
}

#[derive(Accounts)]
pub struct CloseStandby<'info> {
    /// Position 0 — required at this index by Swig's ProgramExec validator on the
    /// FINANCIER leg's following SignV2 (the validator hard-codes
    /// config_account_index = 0). The FINANCIER's swig (identity + authority).
    /// For the USER leg this account is harmless at index 0 — the passkey verifier
    /// reads the instructions_sysvar, not account positions. The handler requires
    /// this equals `vault.standby_backer` for the financier leg.
    /// CHECK: identity-only; never deserialized (the firewall). Equality to the
    /// recorded backer is enforced in the handler.
    pub financier_swig: AccountInfo<'info>,

    /// Position 1 — required at this index by Swig's ProgramExec validator
    /// (wallet_account_index = 1). Derives from the financier's swig. Present and
    /// PDA-constrained for both legs (the user knows the financier swig — it's
    /// recorded on the vault — so this PDA is derivable for the user too).
    /// CHECK: PDA constraint validates derivation; never deref.
    #[account(
        seeds = [SWIG_WALLET_ADDRESS_SEED, financier_swig.key().as_ref()],
        bump,
        seeds::program = SWIG_PROGRAM_ID,
    )]
    pub financier_swig_wallet_address: AccountInfo<'info>,

    /// The USER's vault — credit terms cleared here (standby_backer = None,
    /// standby_cap = 0). Mutated.
    #[account(mut)]
    pub vault: Account<'info, Vault>,

    /// The financier's reserve ledger. `aggregate_promised` is decremented by this
    /// vault's cap here. PDA-bound to `financier_swig`; the handler additionally
    /// requires `standby_backer.financier_swig == vault.standby_backer` so the
    /// ledger ties to the vault's recorded backer. Mutated.
    #[account(
        mut,
        seeds = [STANDBY_BACKER_SEED, financier_swig.key().as_ref()],
        bump = standby_backer.bump,
    )]
    pub standby_backer: Account<'info, StandbyBacker>,

    /// CHECK: instructions sysvar — address-constrained. USER leg: the PREVIOUS
    /// instruction is the secp256r1_verify carrying the user's passkey signature.
    /// FINANCIER leg: the FOLLOWING instruction is the swig::SignV2 that proves
    /// financier authority.
    #[account(address = sysvar::instructions::ID)]
    pub instructions_sysvar: AccountInfo<'info>,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct CloseStandbyArgs {
    /// Which party is consenting. Selects the consent leg in the handler.
    pub closer: Closer,
    /// USER leg only: WebAuthn clientDataJSON; challenge must be sha256(op_message).
    /// Ignored for the financier leg.
    pub client_data_json: Vec<u8>,
    /// USER leg only: WebAuthn authenticatorData (37+ bytes). Ignored for the
    /// financier leg.
    pub authenticator_data: Vec<u8>,
}

/// Shared core logic — runs AFTER whichever consent leg passed. Version guard →
/// must-have-a-standby → borrowed==0 gate → ledger-matches-backer → decrement
/// aggregate by cap + clear terms. Both legs call this.
fn close_standby_core(vault: &mut Vault, standby_backer: &mut StandbyBacker) -> Result<()> {
    // Version guard.
    require!(
        vault.version == VAULT_VERSION_V5,
        VaultError::UnsupportedVaultVersion
    );
    // Must have a standby to close.
    let backer = vault.standby_backer.ok_or(VaultError::NoStandbyBacker)?;
    // The borrowed gate: cannot close with an open loan.
    require!(vault.borrowed == 0, VaultError::StandbyStillBorrowed);
    // Ledger must match the vault's current backer.
    require!(
        standby_backer.financier_swig == backer,
        VaultError::NoStandbyBackerLedger
    );

    // Decrement aggregate by this vault's cap, clear terms. saturating_sub so a
    // stale/under-counted ledger can never underflow-panic the close.
    let cap = vault.standby_cap;
    standby_backer.aggregate_promised = standby_backer.aggregate_promised.saturating_sub(cap);
    vault.standby_backer = None;
    vault.standby_cap = 0;

    Ok(())
}

pub fn handler(ctx: Context<CloseStandby>, args: CloseStandbyArgs) -> Result<()> {
    // Resolve the recorded backer up front — both legs bind to it. (Re-read in
    // the core for the actual mutation; here it's needed for the consent legs.)
    let backer = ctx
        .accounts
        .vault
        .standby_backer
        .ok_or(VaultError::NoStandbyBacker)?;

    match args.closer {
        Closer::User => {
            // USER consent leg: the user's vault passkey MUST have signed
            // "close_standby" || vault || financier_swig. Bound to the vault +
            // backer so the signature can't be replayed against a different vault
            // or a different recorded backer.
            let vault_key = ctx.accounts.vault.key();
            let mut op_msg = Vec::with_capacity(b"close_standby".len() + 32 + 32);
            op_msg.extend_from_slice(b"close_standby");
            op_msg.extend_from_slice(vault_key.as_ref());
            op_msg.extend_from_slice(backer.as_ref());

            verify_passkey_signed(
                &ctx.accounts.instructions_sysvar,
                &ctx.accounts.vault.passkey_pubkey,
                &args.client_data_json,
                &args.authenticator_data,
                &op_msg,
            )?;
        }
        Closer::Financier => {
            // FINANCIER consent leg: the passed financier_swig MUST be the vault's
            // recorded backer (the swig at accounts[0..1] the following SignV2
            // authenticates). Consent itself is the paired [N+1] swig::SignV2 whose
            // ProgramExec marker is THIS instruction's discriminator on the
            // financier's swig — Swig enforces the marker + authority. We mirror
            // set_standby_reserve / draw_credit: NO manual SignV2 parse here; the
            // handler only asserts account shape, Swig does the rest.
            // A backer EXISTS (checked in core); this asserts the financier_swig
            // passed matches it. StandbyBackerMismatch is the accurate variant —
            // the close caller is the wrong financier, not "no backer configured".
            require!(
                ctx.accounts.financier_swig.key() == backer,
                VaultError::StandbyBackerMismatch
            );
        }
    }

    close_standby_core(&mut ctx.accounts.vault, &mut ctx.accounts.standby_backer)
}
