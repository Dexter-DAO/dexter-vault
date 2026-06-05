//! set_swig_atomic — single-instruction warmup.
//!
//! CPIs into the Swig program four times (CreateV1 + 3× AddAuthority for
//! roles 1/2/3), then verifies the secp256r1 precompile sibling matches the
//! "set_swig" || swig_address operation message, then writes
//! vault.swig_address. All four CPIs and the precompile-sibling check happen
//! inside one tx-level instruction — Solana's transaction atomicity gives us
//! all-or-nothing for free.
//!
//! Signer model: the outer-tx fee payer is the role-0 bootstrap authority on
//! the new Swig (matches the @dexterai/vault buildSwigCreationBundle TS
//! shape). The fee payer is a tx-level signer; CPI rules forward signer
//! privilege automatically, so each AddAuthority CPI passes the fee payer
//! through with is_signer=true via `invoke` (no `invoke_signed` PDA gymnastics
//! needed — our vault PDA never signs Swig CPIs).
//!
//! Wire-shape match: the bytes produced by each of the 4 CPIs MUST be
//! byte-identical to what @dexterai/vault's buildSwigCreationBundle produces
//! today, so existing swig-readers (verifySwigIsOurs, etc.) keep working
//! unchanged. The byte-parity test in @dexterai/vault v0.2.0 locks this.
//!
//! Implementation note: we depend on swig-state directly and use a tiny
//! vendored `crate::swig_compat` module for the args structs that upstream
//! keeps in the swig program crate (host-only — won't compile to SBF). See
//! that module's header for the full justification.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::{
    instruction::{AccountMeta, Instruction},
    program::invoke,
    sysvar,
};
use swig_state::action::{
    all::All, manage_authority::ManageAuthority, program_all::ProgramAll, token_limit::TokenLimit,
};
use swig_state::authority::AuthorityType;

/// Wire-format length of a ProgramExec authority payload, mirroring upstream
/// `ProgramExecAuthority` (state/src/authority/programexec/mod.rs):
///   program_id (32) || prefix_len (1) || padding (7) || prefix (40, zero-padded)
const PROGRAM_EXEC_AUTH_LEN: usize = 32 + 1 + 7 + 40;
const PROGRAM_EXEC_MAX_PREFIX_LEN: usize = 40;
const PROGRAM_EXEC_PREFIX_OFFSET: usize = 32 + 1 + 7;

/// Wire-format length of a CreateEd25519SessionAuthority payload, mirroring
/// upstream (state/src/authority/ed25519.rs): pubkey(32) || session_key(32) || max_session_length(8).
const ED25519_SESSION_CREATE_LEN: usize = 32 + 32 + 8;

use crate::state::*;
use crate::swig_compat::{
    build_add_authority_v1_ed25519_acting_data, build_create_v1_data, ClientActionCompat,
};
use crate::verify::webauthn::verify_passkey_signed;

/// Deployed Swig program ID (mainnet + devnet — same address).
pub const SWIG_PROGRAM_ID: Pubkey =
    anchor_lang::pubkey!("swigypWHEksbC64pWKwah1WTeh9JXwx8H1rJHLdbQMB");

/// Marker for role 1 — ProgramExec(vault, finalize_withdrawal).
/// MUST match @dexterai/vault SWIG_PROGRAM_EXEC_PREFIX byte-for-byte.
pub const SWIG_MARKER_FINALIZE_WITHDRAWAL: [u8; 8] = [178, 87, 206, 68, 201, 186, 164, 232];

/// Marker for role 3 — ProgramExec(vault, settle_tab_voucher).
/// MUST match @dexterai/vault SWIG_PROGRAM_EXEC_PREFIX_SETTLE_TAB byte-for-byte.
pub const SWIG_MARKER_SETTLE_TAB: [u8; 8] = [173, 22, 98, 31, 110, 129, 59, 161];

/// MUST match @dexterai/vault DEFAULT_SESSION_TTL_SECONDS (30 days).
pub const DEFAULT_SESSION_TTL_SECONDS: u64 = 30 * 24 * 60 * 60;

/// MUST match @dexterai/vault DEFAULT_SPEND_LIMIT_ATOMIC.
pub const DEFAULT_SPEND_LIMIT_ATOMIC: u64 = 1_000_000_000;

/// USDC mainnet mint — MUST match @dexterai/vault USDC_MAINNET.
pub const USDC_MAINNET: Pubkey =
    anchor_lang::pubkey!("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");

/// Acting-authority account index in our AddAuthorityV1 CPI's account list.
/// Order is [swig_account, payer, system_program, authority] — authority is
/// at index 3, matching swig-interface's hard-coded trailing byte.
const ACTING_AUTHORITY_ACCOUNT_INDEX: u8 = 3;

#[derive(Accounts)]
pub struct SetSwigAtomic<'info> {
    /// The dexter-vault PDA — initialized by initialize_vault, mutated here
    /// (we set swig_address).
    #[account(mut)]
    pub vault: Account<'info, Vault>,

    /// The fee payer + role-0 bootstrap authority. MUST be a tx-level signer.
    #[account(mut)]
    pub fee_payer: Signer<'info>,

    /// The Swig state account, derived as `findProgramAddress([swig_id], swig_program)`.
    /// Swig will initialize it during the CreateV1 CPI.
    /// CHECK: validated by the Swig program when it tries to write here.
    #[account(mut)]
    pub swig_account: UncheckedAccount<'info>,

    /// The Swig wallet PDA (different from swig_account — it's the spending
    /// authority address). CPI'd into by CreateV1.
    /// CHECK: validated by the Swig program.
    #[account(mut)]
    pub swig_wallet_address: UncheckedAccount<'info>,

    /// The Swig program itself.
    /// CHECK: address-constrained to the deployed Swig program ID.
    #[account(address = SWIG_PROGRAM_ID)]
    pub swig_program: UncheckedAccount<'info>,

    /// System program. Declared readonly at the outer-ix level — Solana's
    /// runtime demotes the System Program to readonly anyway (program-id
    /// accounts cannot be writable in the outer transaction). All inner CPIs
    /// (both CreateV1 and AddAuthority) therefore pass System Program as
    /// `AccountMeta::new_readonly(...)` to avoid privilege escalation.
    /// `system_program::CreateAccount` itself doesn't require the System
    /// Program account to be writable — it operates on `from`/`to`.
    pub system_program: Program<'info, System>,

    /// Instructions sysvar — read by verify_passkey_signed.
    /// CHECK: address-constrained.
    #[account(address = sysvar::instructions::ID)]
    pub instructions_sysvar: AccountInfo<'info>,
}

#[derive(AnchorSerialize, AnchorDeserialize)]
pub struct SetSwigAtomicArgs {
    /// 32-byte Swig ID (HMAC-derived client-side from identity_seed + hmac_key).
    pub swig_id: [u8; 32],
    /// Bump for swig_account.
    pub swig_account_bump: u8,
    /// Bump for swig_wallet_address PDA.
    pub swig_wallet_address_bump: u8,
    /// Becomes role-2 (Ed25519Session) authority.
    pub dexter_master_pubkey: Pubkey,
    /// WebAuthn clientDataJSON (challenge = sha256("set_swig" || swig_address_bytes)).
    pub client_data_json: Vec<u8>,
    /// WebAuthn authenticatorData (37+ bytes).
    pub authenticator_data: Vec<u8>,
}

pub fn handler(ctx: Context<SetSwigAtomic>, args: SetSwigAtomicArgs) -> Result<()> {
    let vault = &mut ctx.accounts.vault;

    require!(
        vault.version == VAULT_VERSION_V3 || vault.version == VAULT_VERSION_V2,
        VaultError::UnsupportedVaultVersion
    );
    require!(
        vault.swig_address == Pubkey::default(),
        VaultError::PasskeyVerificationFailed
    );

    let swig_account = ctx.accounts.swig_account.key();
    let fee_payer = ctx.accounts.fee_payer.key();
    let dexter_master = args.dexter_master_pubkey;
    let fee_payer_bytes = fee_payer.to_bytes();

    // ============================================================
    // CPI 1: Swig CreateV1 — initialize state with role 0 (Ed25519,
    // fee_payer, ManageAuthority-only).
    // ============================================================
    let create_data = build_create_v1_data(
        args.swig_id,
        args.swig_account_bump,
        args.swig_wallet_address_bump,
        AuthorityType::Ed25519,
        &fee_payer_bytes,
        &[ClientActionCompat::ManageAuthority(ManageAuthority)],
    )?;
    let create_ix = Instruction {
        program_id: SWIG_PROGRAM_ID,
        accounts: vec![
            AccountMeta::new(swig_account, false),
            AccountMeta::new(fee_payer, true),
            AccountMeta::new(ctx.accounts.swig_wallet_address.key(), false),
            // System Program is passed readonly here even though the upstream
            // swig-interface declares it writable. Solana's runtime demotes
            // program-id accounts to readonly in the outer tx anyway, so the
            // inner CPI MUST claim readonly to avoid privilege escalation.
            // `system_program::CreateAccount` itself doesn't require the
            // System Program account to be writable to function — only the
            // `from`/`to` lamport accounts (here: fee_payer + swig_account)
            // need to be writable, and they are.
            AccountMeta::new_readonly(anchor_lang::solana_program::system_program::ID, false),
        ],
        data: create_data,
    };
    invoke(
        &create_ix,
        &[
            ctx.accounts.swig_account.to_account_info(),
            ctx.accounts.fee_payer.to_account_info(),
            ctx.accounts.swig_wallet_address.to_account_info(),
            ctx.accounts.system_program.to_account_info(),
        ],
    )
    .map_err(|_| error!(VaultError::PasskeyVerificationFailed))?;

    // ============================================================
    // CPI 2: AddAuthority role 1 — ProgramExec(vault, finalize_withdrawal), All.
    // Account order: [swig_account, payer, system_program, authority (=fee_payer)].
    // ============================================================
    let role1_authority_bytes =
        build_program_exec_authority_bytes(&crate::ID.to_bytes(), &SWIG_MARKER_FINALIZE_WITHDRAWAL);
    let add_role1_data = build_add_authority_v1_ed25519_acting_data(
        0, // acting_role_id (role 0 = fee_payer)
        AuthorityType::ProgramExec,
        &role1_authority_bytes,
        &[ClientActionCompat::All(All)],
        ACTING_AUTHORITY_ACCOUNT_INDEX,
    )?;
    let add_role1_ix = Instruction {
        program_id: SWIG_PROGRAM_ID,
        accounts: vec![
            AccountMeta::new(swig_account, false),
            AccountMeta::new(fee_payer, true),
            AccountMeta::new_readonly(anchor_lang::solana_program::system_program::ID, false),
            AccountMeta::new_readonly(fee_payer, true),
        ],
        data: add_role1_data,
    };
    invoke(
        &add_role1_ix,
        &[
            ctx.accounts.swig_account.to_account_info(),
            ctx.accounts.fee_payer.to_account_info(),
            ctx.accounts.system_program.to_account_info(),
            ctx.accounts.fee_payer.to_account_info(),
        ],
    )
    .map_err(|_| error!(VaultError::PasskeyVerificationFailed))?;

    // ============================================================
    // CPI 3: AddAuthority role 2 — Ed25519Session(dexter_master, TTL'd, token-limited).
    // Action order MUST match the TS bundle: TokenLimit first, then ProgramAll.
    // ============================================================
    // Upstream `CreateEd25519SessionAuthority` is exactly 72 bytes:
    //   public_key (32) || session_key (32, zero for new authority)
    //     || max_session_length (8, LE u64).
    // Matches @swig-wallet/lib's `createEd25519SessionAuthorityInfo`, which
    // slices the encoder output to .slice(0, 72) (no current_session_expiration
    // on the wire — set_into_bytes overlays only the create struct).
    let session_authority_bytes: Vec<u8> = {
        let mut buf = Vec::with_capacity(ED25519_SESSION_CREATE_LEN);
        buf.extend_from_slice(dexter_master.as_ref());
        buf.extend_from_slice(&[0u8; 32]); // session_key — zero for new session-based authority
        buf.extend_from_slice(&DEFAULT_SESSION_TTL_SECONDS.to_le_bytes());
        debug_assert_eq!(buf.len(), ED25519_SESSION_CREATE_LEN);
        buf
    };
    let add_role2_data = build_add_authority_v1_ed25519_acting_data(
        0,
        AuthorityType::Ed25519Session,
        &session_authority_bytes,
        &[
            ClientActionCompat::TokenLimit(TokenLimit {
                token_mint: USDC_MAINNET.to_bytes(),
                current_amount: DEFAULT_SPEND_LIMIT_ATOMIC,
            }),
            ClientActionCompat::ProgramAll(ProgramAll),
        ],
        ACTING_AUTHORITY_ACCOUNT_INDEX,
    )?;
    let add_role2_ix = Instruction {
        program_id: SWIG_PROGRAM_ID,
        accounts: vec![
            AccountMeta::new(swig_account, false),
            AccountMeta::new(fee_payer, true),
            AccountMeta::new_readonly(anchor_lang::solana_program::system_program::ID, false),
            AccountMeta::new_readonly(fee_payer, true),
        ],
        data: add_role2_data,
    };
    invoke(
        &add_role2_ix,
        &[
            ctx.accounts.swig_account.to_account_info(),
            ctx.accounts.fee_payer.to_account_info(),
            ctx.accounts.system_program.to_account_info(),
            ctx.accounts.fee_payer.to_account_info(),
        ],
    )
    .map_err(|_| error!(VaultError::PasskeyVerificationFailed))?;

    // ============================================================
    // CPI 4: AddAuthority role 3 — ProgramExec(vault, settle_tab), All.
    // ============================================================
    let role3_authority_bytes =
        build_program_exec_authority_bytes(&crate::ID.to_bytes(), &SWIG_MARKER_SETTLE_TAB);
    let add_role3_data = build_add_authority_v1_ed25519_acting_data(
        0,
        AuthorityType::ProgramExec,
        &role3_authority_bytes,
        &[ClientActionCompat::All(All)],
        ACTING_AUTHORITY_ACCOUNT_INDEX,
    )?;
    let add_role3_ix = Instruction {
        program_id: SWIG_PROGRAM_ID,
        accounts: vec![
            AccountMeta::new(swig_account, false),
            AccountMeta::new(fee_payer, true),
            AccountMeta::new_readonly(anchor_lang::solana_program::system_program::ID, false),
            AccountMeta::new_readonly(fee_payer, true),
        ],
        data: add_role3_data,
    };
    invoke(
        &add_role3_ix,
        &[
            ctx.accounts.swig_account.to_account_info(),
            ctx.accounts.fee_payer.to_account_info(),
            ctx.accounts.system_program.to_account_info(),
            ctx.accounts.fee_payer.to_account_info(),
        ],
    )
    .map_err(|_| error!(VaultError::PasskeyVerificationFailed))?;

    // ============================================================
    // Verify secp256r1 sibling — same as set_swig.
    // Operation message: "set_swig" || swig_address_bytes (matches the TS
    // buildSetSwigOperationMessage to preserve SDK byte-parity).
    // ============================================================
    let mut op_msg = Vec::with_capacity(b"set_swig".len() + 32);
    op_msg.extend_from_slice(b"set_swig");
    op_msg.extend_from_slice(swig_account.as_ref());

    verify_passkey_signed(
        &ctx.accounts.instructions_sysvar,
        &vault.passkey_pubkey,
        &args.client_data_json,
        &args.authenticator_data,
        &op_msg,
    )?;

    // ============================================================
    // Final state write — same as set_swig.
    // ============================================================
    vault.swig_address = swig_account;

    Ok(())
}

/// Build the 80-byte wire-format payload for a `ProgramExec` authority,
/// matching upstream `ProgramExecAuthority::create_authority_data`
/// (state/src/authority/programexec/mod.rs) byte-for-byte.
///
/// Layout: `program_id(32) || prefix_len(1) || padding(7) || prefix(40, zero-padded)`.
/// Upstream's `set_into_bytes` rejects anything other than this exact 80-byte
/// length with `SwigStateError::InvalidRoleData` (custom error 1003 / 0x3eb).
fn build_program_exec_authority_bytes(program_id: &[u8; 32], prefix: &[u8]) -> Vec<u8> {
    let prefix_len = prefix.len().min(PROGRAM_EXEC_MAX_PREFIX_LEN);
    let mut buf = vec![0u8; PROGRAM_EXEC_AUTH_LEN];
    buf[..32].copy_from_slice(program_id);
    buf[32] = prefix_len as u8;
    // bytes 33..40 are padding (already zeroed)
    buf[PROGRAM_EXEC_PREFIX_OFFSET..PROGRAM_EXEC_PREFIX_OFFSET + prefix_len]
        .copy_from_slice(&prefix[..prefix_len]);
    // remaining prefix bytes already zero-padded from the initial vec![0u8; LEN]
    buf
}
