use anchor_lang::prelude::*;
use anchor_lang::Discriminator;

use crate::state::*;

/// Migrate a V2 vault account to the V3 (enlarged-session) layout.
///
/// # Why this instruction exists
///
/// V3 appended two `u64` fields (`current_outstanding`, `max_revolving_capacity`)
/// to the END of `SessionRegistration`, which is itself the LAST field of
/// `Vault` (inside `Option<SessionRegistration>`). That enlarges
/// `Vault::INIT_SPACE` by 16 bytes. The 264 V2 vaults already on mainnet were
/// serialized under the OLD 92-byte `SessionRegistration` layout; the 23 of
/// them carrying `active_session = Some(..)` are now 16 bytes too short for the
/// V3 struct. This instruction reallocs each V2 account to the V3 size, fixes
/// the trailing bytes, and bumps `version` 2 -> 3.
///
/// # The deserialization chicken-and-egg (why `AccountInfo`, not `Account<Vault>`)
///
/// A normal `Account<'info, Vault>` deserializes the WHOLE account on
/// instruction entry against the CURRENT (V3, larger) struct. A Some-session V2
/// vault is 16 bytes too short for that, so Anchor's auto-deserialize would
/// FAIL to load the very account we are trying to fix — the migration could not
/// even read its input. We therefore take the vault as a `/// CHECK:`'d
/// `AccountInfo` (no auto-deserialize) and do everything by hand:
///   1. verify the 8-byte Anchor discriminator equals `Vault::DISCRIMINATOR`,
///   2. require the version byte (offset 8) == `VAULT_VERSION_V2`,
///   3. read ONLY the prefix fields up to and including `dexter_authority` to
///      authority-gate the call (we deliberately do NOT read `active_session`,
///      the field that would over-run the short buffer),
///   4. realloc to `8 + Vault::INIT_SPACE` with zero-init of the grown bytes,
///   5. write `version = VAULT_VERSION_V3`.
///
/// # Why a trailing zero-fill IS the correct migration
///
/// `SessionRegistration` field order is:
///   session_pubkey[32], max_amount(u64), expires_at(i64),
///   allowed_counterparty(Pubkey 32), nonce(u32), spent(u64),
///   current_outstanding(u64), max_revolving_capacity(u64)   <-- the two new
/// The two new fields are the LAST two fields of the LAST field of `Vault`.
/// So for a Some-session vault, growing the account by 16 bytes and zero-filling
/// the new trailing 16 bytes places exactly `current_outstanding = 0` followed
/// by `max_revolving_capacity = 0` at precisely the offsets the V3 layout reads
/// them from. No byte shuffling is needed — append-at-end + zero-fill-at-end is
/// the migration. (`AccountInfo::resize` zero-extends the grown region for us.)
///
/// For a None-session vault, `active_session` is a single `0` Option-discriminant
/// byte; the 16 grown bytes are unused trailing slack until a session is
/// registered (which requires V3 anyway), so growing it is harmless.
///
/// # Legacy-session caveat: `max_revolving_capacity = 0`
///
/// A migrated Some-session vault ends up with `max_revolving_capacity = 0`,
/// which means its EXISTING (legacy) session cannot open any new revolving
/// exposure — the admission cap is 0. This is ACCEPTABLE: these are test
/// vaults, a migrated live session is a legacy session, and the buyer can
/// `revoke_session_key` + `register_session_key` to obtain a real cap under V3.
/// We deliberately do NOT invent a cap for legacy sessions.
///
/// # Authority gating
///
/// Mirrors the privileged-op model used elsewhere (`settle_voucher`,
/// `rotate_dexter_authority`): the vault's recorded `dexter_authority` must
/// sign. Because we cannot use Anchor's `has_one` (that needs a typed account),
/// we read `dexter_authority` out of the raw buffer by hand and compare it to
/// the signer. The `payer` (also a signer) funds the rent for the 16 extra
/// bytes; realloc-growth requires the account stay rent-exempt.
#[derive(Accounts)]
pub struct MigrateV2ToV3<'info> {
    /// CHECK: This is a V2 `Vault` account that is 16 bytes too short for the
    /// V3 struct, so it CANNOT be loaded as `Account<'info, Vault>` (the
    /// auto-deserialize would over-run the buffer on the `active_session`
    /// field). We validate it manually in the handler: discriminator match,
    /// version == 2, and `dexter_authority` ownership. We also require it be
    /// owned by this program before touching its bytes.
    #[account(mut, owner = crate::ID)]
    pub vault: AccountInfo<'info>,

    /// Must equal the vault's recorded `dexter_authority`. Same authority that
    /// gates `settle_voucher` / `rotate_dexter_authority`. Validated by hand
    /// against the raw buffer (no `has_one`, since the vault is untyped here).
    pub dexter_authority: Signer<'info>,

    /// Funds the rent for the 16 extra bytes the realloc adds. A separate
    /// signer so the authority key need not hold lamports.
    #[account(mut)]
    pub payer: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(AnchorSerialize, AnchorDeserialize)]
pub struct MigrateV2ToV3Args {}

pub fn handler(ctx: Context<MigrateV2ToV3>, _args: MigrateV2ToV3Args) -> Result<()> {
    let vault_ai = &ctx.accounts.vault;

    // ---- (1) discriminator must match Vault -------------------------------
    {
        let data = vault_ai.try_borrow_data()?;
        require!(data.len() >= 9, VaultError::UnsupportedVaultVersion);
        require!(
            &data[0..8] == Vault::DISCRIMINATOR,
            VaultError::UnsupportedVaultVersion
        );

        // ---- (2) version byte (offset 8) must be exactly V2 ---------------
        require!(
            data[8] == VAULT_VERSION_V2,
            VaultError::UnsupportedVaultVersion
        );

        // ---- (3) authority-gate by reading the prefix ONLY ----------------
        // We borsh-decode each field in declaration order STARTING at offset 8
        // (after the 8-byte discriminator) up to and including `dexter_authority`,
        // then STOP. We never touch `active_session`, the trailing field whose
        // V3 length over-runs this short V2 buffer. Every field read here is
        // identical in the V2 and V3 layouts (only SessionRegistration grew),
        // so this prefix decode is layout-stable across the migration.
        let mut cursor: &[u8] = &data[8..];
        let _version = u8::deserialize(&mut cursor)?;
        let _bump = u8::deserialize(&mut cursor)?;
        let _passkey_pubkey = <[u8; 33]>::deserialize(&mut cursor)?;
        let _swig_address = Pubkey::deserialize(&mut cursor)?;
        let _cooling_off_seconds = u32::deserialize(&mut cursor)?;
        let _pending_voucher_count = u32::deserialize(&mut cursor)?;
        // `pending_withdrawal: Option<PendingWithdrawal>` is variable length
        // (1 byte if None, 1 + 48 if Some) — which is exactly why
        // `dexter_authority` has no fixed offset and must be reached by decoding.
        let _pending_withdrawal = Option::<PendingWithdrawal>::deserialize(&mut cursor)?;
        let _identity_claim = <[u8; 32]>::deserialize(&mut cursor)?;
        let recorded_authority = Pubkey::deserialize(&mut cursor)?;

        require!(
            recorded_authority == ctx.accounts.dexter_authority.key(),
            VaultError::PasskeyVerificationFailed
        );
    } // drop the data borrow before realloc takes a mut borrow

    // ---- (4) realloc to the V3 size, zero-filling the grown 16 bytes ------
    // new_size = 8 (discriminator) + V3 INIT_SPACE. For a Some-session vault
    // the two zero-filled trailing bytes ARE current_outstanding=0 followed by
    // max_revolving_capacity=0 (see module doc). The growth here is exactly 16
    // bytes for a Some-session vault — well under MAX_PERMITTED_DATA_INCREASE.
    let new_size = 8 + Vault::INIT_SPACE;
    let old_size = vault_ai.data_len();

    if new_size > old_size {
        // Top up rent so the enlarged account stays rent-exempt. The payer
        // funds the delta via a system-program transfer.
        let rent = Rent::get()?;
        let new_minimum = rent.minimum_balance(new_size);
        let current_lamports = vault_ai.lamports();
        if new_minimum > current_lamports {
            let top_up = new_minimum - current_lamports;
            anchor_lang::system_program::transfer(
                CpiContext::new(
                    ctx.accounts.system_program.to_account_info(),
                    anchor_lang::system_program::Transfer {
                        from: ctx.accounts.payer.to_account_info(),
                        to: vault_ai.to_account_info(),
                    },
                ),
                top_up,
            )?;
        }

        // `resize` zero-extends the grown region (it calls the old
        // `realloc(new_len, /* zero_init */ true)` internally). Zero-filling the
        // grown bytes IS the entire migration for the trailing new session
        // fields (current_outstanding=0, max_revolving_capacity=0).
        vault_ai.resize(new_size)?;
    }

    // ---- (5) bump version 2 -> 3 ------------------------------------------
    {
        let mut data = vault_ai.try_borrow_mut_data()?;
        data[8] = VAULT_VERSION_V3;
    }

    Ok(())
}
