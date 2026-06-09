//! Credit Level 2 — `close_standby`. THE RELEASE. Tears down a vault's standby
//! credit relationship: clears `standby_backer` / `standby_cap` on the USER's
//! vault AND decrements the financier's `aggregate_promised` on their
//! StandbyBacker ledger by this vault's cap. Callable by EITHER party:
//!   - the USER (passkey consent over an op-message), or
//!   - the FINANCIER (swig-authority consent — mechanism B: the close runs as the
//!     inner CPI of the financier's swig SignV2, which signs with the financier's
//!     swig_wallet PDA via invoke_signed; no swig authority → no signature → revert).
//! Gated on `vault.borrowed == 0` — you cannot release a standby while a loan
//! is still open against it (`StandbyStillBorrowed`).
//!
//! ── SINGLE-INSTRUCTION DESIGN (not split) ────────────────────────────────────
//! Two consent legs share ONE accounts struct, because their requirements do not
//! conflict — each leg checks its own consent IN the handler arm:
//!
//!   FINANCIER leg (mechanism B): no ProgramExec marker, no adjacency. The close
//!     binds to the financier's swig authority by requiring the financier's
//!     `financier_swig_wallet_address` PDA to be a SIGNER. The only way to produce
//!     that signature is for Swig to invoke_signed it as the inner CPI of the
//!     financier's swig SignV2. The is_signer check lives in the `Closer::Financier`
//!     arm (the struct can't type this account as `Signer` — the user leg shares the
//!     same struct and does NOT sign that PDA). This is the same consent rule the
//!     sister set_standby_reserve enforces structurally via a `Signer` field.
//!
//!   USER leg: needs only (a) the vault (to read passkey_pubkey + clear terms)
//!     and (b) the secp256r1 precompile sibling. `verify_passkey_signed` locates
//!     that sibling purely by reading `instructions_sysvar` at
//!     `current_index - 1` — it NEVER inspects `ctx.accounts` positions, and it
//!     never signs the financier's swig_wallet PDA. The user knows the financier
//!     swig regardless — it's recorded on their vault as `standby_backer`.
//!
//! Therefore a SINGLE struct serves BOTH legs: the financier path requires the
//! swig_wallet signer (checked in-arm) and the user path requires the passkey
//! (checked in-arm) — neither conflicts. The handler branches on `args.closer`.
//! Splitting into two instructions would duplicate the account struct and the
//! core logic for zero benefit.
//!
//! Transaction shapes:
//!   USER:
//!     [N-1] secp256r1_verify(user passkey over "close_standby"||vault||financier)
//!     [N]   vault::close_standby { closer: User }
//!   FINANCIER:
//!     swig::SignV2 on the financier's swig, whose inner CPI is
//!       vault::close_standby { closer: Financier }. Swig invoke_signed's the
//!       financier's swig_wallet PDA, satisfying the in-arm is_signer check.
//!       No money moves — consent is the signature, not a marker.
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
    /// The FINANCIER's swig (identity + authority). On the FINANCIER leg the handler
    /// requires this equals `vault.standby_backer` (the right financier). On the USER
    /// leg it's harmless — the passkey verifier reads the instructions_sysvar, not
    /// account positions, and the user knows the financier swig regardless (it's
    /// recorded on their vault).
    /// CHECK: identity-only; never deserialized (the firewall). Equality to the
    /// recorded backer is enforced in the handler.
    pub financier_swig: AccountInfo<'info>,

    /// The financier's swig_wallet PDA, derived from `financier_swig`. On the
    /// FINANCIER leg this PDA MUST SIGN (mechanism B consent — checked in-handler via
    /// `is_signer`): the close runs only as the inner CPI of the financier's swig
    /// SignV2, which invoke_signed's this PDA. It is NOT typed `Signer` at the struct
    /// level because the USER leg shares this struct and does not sign it; the seeds
    /// prove it's the right financier's wallet PDA when it IS the signer.
    /// CHECK: PDA constraint validates derivation; signer enforced in-handler; never deref.
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

    /// CHECK: instructions sysvar — address-constrained. Used by the USER leg only:
    /// `verify_passkey_signed` reads the PREVIOUS instruction (current_index - 1),
    /// the secp256r1_verify carrying the user's passkey signature. The FINANCIER leg
    /// does NOT read it — its consent is the swig_wallet signer (mechanism B), not an
    /// adjacent instruction.
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
        vault.version == VAULT_VERSION_V5 || vault.version == VAULT_VERSION_V6,
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
            const TAG: &[u8] = b"close_standby";
            let mut op_msg = Vec::with_capacity(TAG.len() + 32 + 32);
            op_msg.extend_from_slice(TAG);
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
            // Identity: must be the vault's recorded backer (the right financier).
            // A backer EXISTS (resolved up front at the top of handler via
            // ok_or(NoStandbyBacker)); this asserts the financier_swig passed
            // matches it. StandbyBackerMismatch is the accurate variant — the
            // close caller is the wrong financier, not "no backer configured".
            require!(
                ctx.accounts.financier_swig.key() == backer,
                VaultError::StandbyBackerMismatch
            );
            // Consent (mechanism B): this close runs ONLY as the inner CPI of the
            // financier's swig SignV2, which signs with the financier's swig_wallet PDA
            // (invoke_signed). The PDA-constrained financier_swig_wallet_address MUST be
            // a signer — the only way to produce that signature is the financier's swig
            // authority. The close effect cannot land without it. This REPLACES the old
            // ProgramExec-marker adjacency (which proved a sibling ix existed but gated
            // nothing — the vacuous-consent bug).
            require!(
                ctx.accounts.financier_swig_wallet_address.is_signer,
                VaultError::FinancierConsentMissing
            );
        }
    }

    close_standby_core(&mut ctx.accounts.vault, &mut ctx.accounts.standby_backer)
}
