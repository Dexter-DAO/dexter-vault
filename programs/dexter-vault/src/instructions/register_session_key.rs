use anchor_lang::prelude::*;
use anchor_lang::solana_program::sysvar;
use anchor_spl::token::TokenAccount;

use crate::constants::{SWIG_PROGRAM_ID, SWIG_WALLET_ADDRESS_SEED};
use crate::state::*;
use crate::verify::webauthn::verify_passkey_signed;

/// Domain separator for session-key REGISTRATION messages. Padded to 32 bytes
/// with NULs so the serialized message stays byte-aligned and the seller can
/// reconstruct it deterministically. Any change to this literal MUST bump the
/// version in the suffix — older sessions cannot be re-used by a newer client.
///
/// Layout note: 23 bytes of label + 9 NUL = 32 bytes total.
const REGISTER_DOMAIN: &[u8; 32] = b"OTS_SESSION_REGISTER_V2\0\0\0\0\0\0\0\0\0";

#[derive(Accounts)]
#[instruction(args: RegisterSessionKeyArgs)]
pub struct RegisterSessionKey<'info> {
    /// Receives the new `active_session`. Mutated, no signer required: the
    /// passkey signature embedded in the args (verified via the SIMD-0075
    /// precompile sibling) is what authorizes the mutation.
    #[account(mut)]
    pub vault: Account<'info, Vault>,

    /// The swig wallet's USDC ATA — read live to enforce the overcommit
    /// invariant per V0.3 Decision 1: the new session's max_amount plus
    /// the existing outstanding_locked_amount must fit within actual USDC
    /// balance. The ATA's `owner` field is verified against the canonical
    /// swig wallet PDA.
    pub vault_usdc_ata: Account<'info, TokenAccount>,

    /// CHECK: address constraint binds to vault.swig_address.
    #[account(address = vault.swig_address)]
    pub swig: AccountInfo<'info>,

    /// CHECK: PDA constraint validates derivation.
    #[account(
        seeds = [SWIG_WALLET_ADDRESS_SEED, swig.key().as_ref()],
        bump,
        seeds::program = SWIG_PROGRAM_ID,
    )]
    pub swig_wallet_address: AccountInfo<'info>,

    /// CHECK: instructions sysvar — address-constrained. The previous
    /// instruction in the transaction MUST be a secp256r1_verify call whose
    /// signed message is `authenticatorData || sha256(clientDataJSON)` and
    /// whose `clientDataJSON.challenge` decodes to sha256(registration_message).
    #[account(address = sysvar::instructions::ID)]
    pub instructions_sysvar: AccountInfo<'info>,

    /// The per-counterparty session PDA. init_if_needed: created on the first
    /// register to this counterparty, OVERWRITTEN (replace-in-place) on a
    /// subsequent register. The seed binds it to (vault, allowed_counterparty),
    /// so it cannot be redirected. Re-init safety (SOL-010): the handler fully
    /// overwrites every passkey-endorsed scope field (Task 5).
    #[account(
        init_if_needed,
        payer = payer,
        space = 8 + SessionAccount::INIT_SPACE,
        seeds = [crate::constants::SESSION_SEED, vault.key().as_ref(), args.allowed_counterparty.as_ref()],
        bump,
    )]
    pub session: Account<'info, SessionAccount>,

    /// Funds the session PDA rent on first creation.
    #[account(mut)]
    pub payer: Signer<'info>,

    pub system_program: Program<'info, System>,
    // remaining_accounts: all OTHER live sibling SessionAccounts, strict ascending
    // order, read-only — consumed by the overcommit gate in the handler (Task 5).
}

#[derive(AnchorSerialize, AnchorDeserialize)]
pub struct RegisterSessionKeyArgs {
    /// Ed25519 pubkey the buyer's SDK generated in memory. The passkey is
    /// endorsing this exact key — only this key can sign vouchers for the
    /// duration of the session.
    pub session_pubkey: [u8; 32],
    /// Cumulative cap in atomic units. The seller's middleware AND any future
    /// on-chain consumer of `active_session.spent` enforces this.
    pub max_amount: u64,
    /// Wall-clock expiry, unix seconds. Must be strictly in the future.
    pub expires_at: i64,
    /// The seller this session is bound to. Any voucher claiming a different
    /// counterparty MUST be rejected by the seller's verification path.
    pub allowed_counterparty: Pubkey,
    /// Per-session nonce. Combined with `expires_at`, gives each session a
    /// unique fingerprint for off-chain replay protection. Caller picks; the
    /// program does not enforce monotonicity (a non-monotonic nonce is the
    /// buyer's own footgun, not a protocol attack).
    pub nonce: u32,
    /// Cap the revolving meter (`current_outstanding`) is checked against.
    pub max_revolving_capacity: u64,
    /// WebAuthn `clientDataJSON`. Its `challenge` field must base64url-decode
    /// to sha256(registration_message).
    pub client_data_json: Vec<u8>,
    /// WebAuthn `authenticatorData` (37+ bytes).
    pub authenticator_data: Vec<u8>,
}

/// Authorize a session key for off-chain voucher signing.
///
/// One biometric (or hardware-key) prompt at the start of a tab; the session
/// key then signs every voucher during the stream without further prompts. The
/// program never observes voucher traffic — that all happens off-chain between
/// buyer and seller. This instruction's only job is to make the passkey's
/// endorsement of the session pubkey + scope binding part of vault state, so
/// the seller (and any future on-chain consumer) can verify the endorsement
/// deterministically.
///
/// Safety:
///  - The passkey signature is what authorizes mutation. The accounts struct
///    requires no signer; the precompile sibling does the work.
///  - `max_amount` zero is rejected (a meaningless session).
///  - `expires_at` in the past is rejected (a born-dead session).
///  - An existing unexpired session blocks a new one (`SessionAlreadyActive`).
///    Use `revoke_session_key` first to tear down the prior session.
///  - An existing EXPIRED session is silently overwritten — that's how
///    sessions rotate.
pub fn handler<'info>(
    ctx: Context<'_, '_, 'info, 'info, RegisterSessionKey<'info>>,
    args: RegisterSessionKeyArgs,
) -> Result<()> {
    // ── A. expiry + max_amount / revolving sanity ───────────────────────────
    require!(
        ctx.accounts.vault.version == VAULT_VERSION_V4,
        VaultError::UnsupportedVaultVersion
    );
    require!(args.max_amount > 0, VaultError::SessionCapZero);
    require!(args.max_revolving_capacity > 0, VaultError::RevolvingCapacityZero);

    let now = Clock::get()?.unix_timestamp;
    require!(args.expires_at > now, VaultError::SessionExpiryInPast);

    // ── B. ATA-owner check (KEPT verbatim) ───────────────────────────────────
    // The ATA's `owner` is cross-checked against the canonical swig wallet PDA
    // so a caller can't smuggle an unrelated funded ATA into the overcommit gate.
    require!(
        ctx.accounts.vault_usdc_ata.owner == ctx.accounts.swig_wallet_address.key(),
        VaultError::PasskeyVerificationFailed
    );

    // ── C. The overcommit gate (V6 SECURITY CORE) ────────────────────────────
    // Copy the scalars the verify step needs before taking `&mut vault`, and
    // capture the immutable reads the gate needs.
    let vault_key = ctx.accounts.vault.key();
    let passkey = ctx.accounts.vault.passkey_pubkey;
    let live_session_count = ctx.accounts.vault.live_session_count;
    let outstanding_locked_amount = ctx.accounts.vault.outstanding_locked_amount;
    let ata_amount = ctx.accounts.vault_usdc_ata.amount;

    let session_key = ctx.accounts.session.key();
    let is_new = ctx.accounts.session.version == 0;

    require!(live_session_count < 255, VaultError::SessionCountAtMax);

    // overcommit gate over sibling sessions
    let mut sibling_sum: u64 = 0;
    let mut counted: u8 = 0;
    let mut prev: Option<Pubkey> = None;
    for acct in ctx.remaining_accounts.iter() {
        let acct_key = *acct.key;
        // (i) STRICT ascending → dedup + canonical order in one check. `>` not `>=`.
        if let Some(p) = prev {
            require!(acct_key > p, VaultError::SessionAccountsNotSorted);
        }
        prev = Some(acct_key);
        // (ii) the target's own PDA must NOT appear in the sibling set
        require_keys_neq!(acct_key, session_key, VaultError::SessionAccountMisderived);
        // (iii) owner + discriminator + deserialize (read-only). Account::try_from
        //       checks owner==program + the 8-byte discriminator.
        let sib = Account::<SessionAccount>::try_from(acct)
            .map_err(|_| error!(VaultError::SessionAccountForeign))?;
        // (iv) vault-bound + PDA re-derive via STORED bump (create_program_address,
        //      NOT find_program_address — avoids the ~1500 CU bump search per sibling)
        require_keys_eq!(sib.vault, vault_key, VaultError::SessionAccountForeign);
        let expected = Pubkey::create_program_address(
            &[
                crate::constants::SESSION_SEED,
                vault_key.as_ref(),
                sib.session.allowed_counterparty.as_ref(),
                &[sib.bump],
            ],
            ctx.program_id,
        )
        .map_err(|_| error!(VaultError::SessionAccountMisderived))?;
        require_keys_eq!(acct_key, expected, VaultError::SessionAccountMisderived);
        // (v) only LIVE siblings count + sum (same liveness filter live_session_count uses)
        if sib.session.expires_at > now {
            sibling_sum = sibling_sum
                .checked_add(sib.session.max_amount)
                .ok_or(error!(VaultError::SessionWouldOvercommitVault))?;
            counted = counted
                .checked_add(1)
                .ok_or(error!(VaultError::SessionWouldOvercommitVault))?;
        }
    }

    // (vi) completeness: caller passed exactly the live siblings.
    //   expected_siblings = live_session_count − (target already exists ? 1 : 0)
    let expected_siblings = live_session_count
        .checked_sub(if is_new { 0 } else { 1 })
        .ok_or(error!(VaultError::IncompleteSessionSet))?;
    require!(counted == expected_siblings, VaultError::IncompleteSessionSet);

    // (vii) overcommit invariant: siblings + the NEW cap + outstanding_locked <= USDC
    let combined = sibling_sum
        .checked_add(args.max_amount)
        .and_then(|s| s.checked_add(outstanding_locked_amount))
        .ok_or(error!(VaultError::SessionWouldOvercommitVault))?;
    require!(
        combined <= ata_amount,
        VaultError::SessionWouldOvercommitVault
    );

    // ── D. passkey verify (KEPT) ─────────────────────────────────────────────
    // Reconstruct the 188-byte registration message the passkey signed.
    let registration_message = build_registration_message(ctx.program_id, &vault_key, &args);

    verify_passkey_signed(
        &ctx.accounts.instructions_sysvar,
        &passkey,
        &args.client_data_json,
        &args.authenticator_data,
        &registration_message,
    )?;

    // ── E. first-touch + full-overwrite write (replaces vault.active_session) ─
    if is_new {
        let vault = &mut ctx.accounts.vault;
        vault.live_session_count = vault
            .live_session_count
            .checked_add(1)
            .ok_or(error!(VaultError::SessionCountAtMax))?;
    }
    let session = &mut ctx.accounts.session;
    if is_new {
        session.version = SESSION_VERSION_V1;
        session.bump = ctx.bumps.session;
        session.vault = vault_key;
    }
    // FULL overwrite of every passkey-endorsed scope field + reset meters (SOL-010 Mode-B)
    session.session = SessionRegistration {
        session_pubkey: args.session_pubkey,
        max_amount: args.max_amount,
        expires_at: args.expires_at,
        allowed_counterparty: args.allowed_counterparty,
        nonce: args.nonce,
        spent: 0,
        current_outstanding: 0,
        max_revolving_capacity: args.max_revolving_capacity,
        crystallized_cumulative: 0,
        last_locked_sequence: 0,
    };

    Ok(())
}

/// Deterministic 188-byte serialization of the registration message.
///
/// Layout (offsets, little-endian for integers):
///   [  0..32) domain separator literal "OTS_SESSION_REGISTER_V2\0\0\0\0\0\0\0\0\0"
///   [ 32..64) program ID
///   [ 64..96) vault PDA
///   [ 96..128) session_pubkey
///   [128..136) max_amount (u64 LE)
///   [136..144) expires_at (i64 LE)
///   [144..176) allowed_counterparty
///   [176..180) nonce (u32 LE)
///   [180..188) max_revolving_capacity (u64 LE)
///
/// Total: 188 bytes. The seller computes this same byte sequence locally and
/// uses it to verify the registration's WebAuthn ceremony off-chain (one-time
/// per session, cached for the duration).
fn build_registration_message(
    program_id: &Pubkey,
    vault_pda: &Pubkey,
    args: &RegisterSessionKeyArgs,
) -> Vec<u8> {
    let mut msg = Vec::with_capacity(188);
    msg.extend_from_slice(REGISTER_DOMAIN);
    msg.extend_from_slice(program_id.as_ref());
    msg.extend_from_slice(vault_pda.as_ref());
    msg.extend_from_slice(&args.session_pubkey);
    msg.extend_from_slice(&args.max_amount.to_le_bytes());
    msg.extend_from_slice(&args.expires_at.to_le_bytes());
    msg.extend_from_slice(args.allowed_counterparty.as_ref());
    msg.extend_from_slice(&args.nonce.to_le_bytes());
    msg.extend_from_slice(&args.max_revolving_capacity.to_le_bytes());
    debug_assert_eq!(msg.len(), 188);
    msg
}
