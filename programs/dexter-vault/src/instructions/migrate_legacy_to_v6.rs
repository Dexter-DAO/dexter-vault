use anchor_lang::prelude::*;
use anchor_lang::Discriminator;

use crate::state::*;

/// Migrate a PRE-VERSION-BYTE legacy vault (the V1 / V1.5 cohort) to the
/// current V6 layout.
///
/// # Who this is for — the stranded 7
///
/// Seven mainnet vaults predate the `version: u8` field entirely (the byte at
/// offset 8 is the PDA bump, NOT a version). Every versioned migration in this
/// program gates on `data[8] == VAULT_VERSION_*`, so none of them can touch
/// these accounts — they are stranded. Two frozen layouts exist (ground truth
/// from the 2026-06-10 byte-level mainnet investigation):
///
/// **V1 — 151-byte account (5 on mainnet, valueless test relics):**
/// ```text
/// disc[8] | bump u8 | passkey [u8;33] | swig Pubkey | cooling_off i64 |
/// pending_voucher_count u32 | Option<PendingWithdrawal>{u64, Pubkey, i64} |
/// supabase_user_id [u8;16] | zero slack to 151
/// ```
///
/// **V1.5 — 183-byte account (2 on mainnet, REAL USERS):**
/// same fields PLUS `dexter_authority: Pubkey` after `supabase_user_id`.
///
/// Compact Borsh: a `Some` pending_withdrawal shifts everything after it by
/// +48, eating the trailing zero slack exactly (87+48+16 == 151 and
/// 87+48+16+32 == 183), which is why both layouts are a FIXED total size in
/// both the None and Some cases. There is NO version byte in either —
/// discrimination between the two layouts is STRICTLY by account length
/// (151 vs 183) plus the Vault Anchor discriminator. Everything else is
/// rejected (`NotALegacyVault`).
///
/// Note `cooling_off` is an `i64` here (the modern field is `u32`) and the
/// legacy `supabase_user_id` is 16 bytes (the modern `identity_claim` is 32).
///
/// # Authority gating — two paths
///
/// - **183-byte (V1.5)**: the layout STORES a `dexter_authority`; the signer
///   must equal it, exactly like every other privileged op. The stored
///   authority is PRESERVED into V6.
/// - **151-byte (V1)**: there is NO on-chain authority record at all — nothing
///   exists to gate on. These 5 accounts are valueless test relics from before
///   the authority field was added. We gate on `LEGACY_MIGRATE_ADMIN` (the
///   program upgrade-authority wallet) as a deliberate, hardcoded claim: the
///   admin signer is STAMPED as the new `dexter_authority`, adopting the relic
///   under the same wallet that already controls the program itself. This adds
///   no power the upgrade authority does not already have.
///
/// # Decode / re-encode, not in-place edit
///
/// Same chicken-and-egg as the sibling migrations (`migrate_v2_to_v3`,
/// `migrate_v5_to_v6`): a legacy account cannot deserialize through
/// `Account<'info, Vault>` (different field shapes in the MIDDLE of the
/// struct), so the vault arrives as a `/// CHECK:`'d `AccountInfo`, is decoded
/// by a frozen cursor-walk (`decode_legacy_vault`), and re-encoded as the
/// current `Vault` (`encode_v6_image`). Both halves are pure functions over
/// byte slices so they are unit-tested against the REAL on-chain fixture
/// bytes (see the test module at the bottom of this file).
///
/// # Resize + rent (GROW path)
///
/// 151/183 → 8 + Vault::INIT_SPACE (= 279) is a GROW: the payer tops up the
/// lamports to the new rent-exempt minimum, mirroring `migrate_v2_to_v3`.
/// DEPLOY-NIGHT LESSON (from the V5→V6 fix): NEVER assert the serialized
/// payload `== INIT_SPACE` — Borsh writes a None option as ONE byte, so the
/// real payload is SHORTER than `INIT_SPACE` (which budgets every Option at
/// max). `encode_v6_image` requires `<=` and zero-PADS to the target size; the
/// trailing zeros are exactly the None option discriminants the V6 decoder
/// expects.
#[derive(Accounts)]
pub struct MigrateLegacyToV6<'info> {
    /// CHECK: a 151-byte (V1) or 183-byte (V1.5) pre-version-byte legacy
    /// vault. It CANNOT be loaded as `Account<'info, Vault>` (no version byte,
    /// different field shapes), so it is validated entirely by hand in
    /// `decode_legacy_vault`: exact length 151 or 183, Vault discriminator,
    /// full frozen-layout cursor decode. Owner-gated to this program.
    #[account(mut, owner = crate::ID)]
    pub vault: AccountInfo<'info>,

    /// The gate signer. For a 183-byte vault: must equal the STORED
    /// `dexter_authority` (which is preserved into V6). For a 151-byte vault
    /// (no stored authority exists): must equal `LEGACY_MIGRATE_ADMIN`, and is
    /// stamped as the new `dexter_authority`.
    pub authority: Signer<'info>,

    /// Funds the rent top-up for the grow (151/183 → 279 bytes).
    #[account(mut)]
    pub payer: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(AnchorSerialize, AnchorDeserialize)]
pub struct MigrateLegacyToV6Args {}

/// The ONLY signer allowed to migrate (and thereby claim) a 151-byte V1 vault.
///
/// WHY a hardcoded admin: the V1 layout predates the `dexter_authority` field,
/// so those 5 accounts carry NO on-chain authority record — there is nothing
/// stored to gate on. All 5 are valueless test relics (zero balances, dead
/// swigs) from the pre-authority era. This constant is the program
/// upgrade-authority wallet, which already has total power over this program;
/// stamping it as the new `dexter_authority` claims the relics deliberately
/// and visibly rather than leaving them permissionless or permanently
/// stranded.
pub const LEGACY_MIGRATE_ADMIN: Pubkey = pubkey!("X4o2kSLzqEQjnAzhq3L3BW92aawMV2n2F37EXd2GMpy");

/// Exact account length of a V1 (no-authority) legacy vault.
pub const LEGACY_V1_LEN: usize = 151;
/// Exact account length of a V1.5 (with-authority) legacy vault.
pub const LEGACY_V15_LEN: usize = 183;

/// Everything decodable from a frozen legacy vault buffer. `stored_authority`
/// is `Some` only for the 183-byte V1.5 layout (the field does not exist in
/// the 151-byte V1 layout).
#[derive(Debug, Clone)]
pub struct LegacyVaultDecoded {
    pub bump: u8,
    pub passkey_pubkey: [u8; 33],
    pub swig_address: Pubkey,
    /// Legacy type was i64 (the modern field is u32). Live values are tiny
    /// (0 or 86400); `encode_v6_image` clamps into u32 regardless.
    pub cooling_off_seconds: i64,
    pub pending_voucher_count: u32,
    pub pending_withdrawal: Option<PendingWithdrawal>,
    /// Legacy 16-byte identity (the modern `identity_claim` is 32 bytes;
    /// re-encode zero-pads it into bytes [0..16]).
    pub supabase_user_id: [u8; 16],
    pub stored_authority: Option<Pubkey>,
}

/// Frozen cursor-walk decoder for the V1 / V1.5 legacy layouts.
///
/// Pure function over the FULL account buffer (discriminator included) so it
/// is unit-testable against raw fixture bytes with no `AccountInfo`. The
/// layout is discriminated STRICTLY by total length:
///   - 151 bytes → V1   (no `dexter_authority` field)
///   - 183 bytes → V1.5 (`dexter_authority` after `supabase_user_id`)
/// plus the Vault Anchor discriminator at [0..8]. Anything else (truncated,
/// foreign account, already-versioned vault of any size) → `NotALegacyVault`.
///
/// The walk is COMPACT Borsh: `pending_withdrawal` is 1 byte when None, 1+48
/// when Some — a Some shifts every later field by +48, exactly consuming the
/// trailing zero slack (so total length is invariant). Decoding field-by-field
/// with Borsh means we never hand-compute a post-Option offset. A Some-tagged
/// buffer has exactly enough bytes by construction (87+48+16[+32] == the
/// length gate), and any tag other than 0/1 fails Borsh's Option decode.
pub fn decode_legacy_vault(data: &[u8]) -> Result<LegacyVaultDecoded> {
    require!(
        data.len() == LEGACY_V1_LEN || data.len() == LEGACY_V15_LEN,
        VaultError::NotALegacyVault
    );
    require!(
        &data[0..8] == Vault::DISCRIMINATOR,
        VaultError::NotALegacyVault
    );

    // Cursor starts after the 8-byte discriminator. NOTE: byte 8 is the PDA
    // BUMP — there is no version byte anywhere in these layouts.
    let mut cursor: &[u8] = &data[8..];
    let bump = u8::deserialize(&mut cursor)?;
    let passkey_pubkey = <[u8; 33]>::deserialize(&mut cursor)?;
    let swig_address = Pubkey::deserialize(&mut cursor)?;
    let cooling_off_seconds = i64::deserialize(&mut cursor)?; // legacy i64, NOT u32
    let pending_voucher_count = u32::deserialize(&mut cursor)?;
    let pending_withdrawal = Option::<PendingWithdrawal>::deserialize(&mut cursor)?;
    let supabase_user_id = <[u8; 16]>::deserialize(&mut cursor)?;
    let stored_authority = if data.len() == LEGACY_V15_LEN {
        Some(Pubkey::deserialize(&mut cursor)?)
    } else {
        None
    };
    // Remaining cursor bytes are the trailing zero slack (48 for None
    // pending_withdrawal, 0 for Some) — discarded, never interpreted.

    Ok(LegacyVaultDecoded {
        bump,
        passkey_pubkey,
        swig_address,
        cooling_off_seconds,
        pending_voucher_count,
        pending_withdrawal,
        supabase_user_id,
        stored_authority,
    })
}

/// Re-encode a decoded legacy vault as the CURRENT V6 `Vault` byte image.
///
/// Pure function: returns the full account image (discriminator + body),
/// zero-padded to exactly `8 + Vault::INIT_SPACE`. Every field of the current
/// struct is written explicitly:
///   - preserved:  bump, passkey, swig, pending_voucher_count,
///                 pending_withdrawal (carried through the Option)
///   - converted:  cooling_off i64 → u32 (clamped; live values are 0 / 86400),
///                 supabase_user_id [u8;16] → identity_claim bytes [0..16],
///                 zero-padded to 32
///   - stamped:    version = V6, dexter_authority = caller-resolved (stored
///                 authority for V1.5, LEGACY_MIGRATE_ADMIN for V1)
///   - neutral:    live_session_count = 0 and ALL V4/V5/V6 credit +
///                 accounting fields = 0 / None (these eras never touched
///                 legacy vaults)
///
/// DEPLOY-NIGHT LESSON (the migrate_v5_to_v6 `== new_size` bug): Borsh
/// serializes a None option as a SINGLE byte, so the payload is SHORTER than
/// `INIT_SPACE` (which budgets Options at max). Require `<=`, then zero-pad —
/// the trailing zeros ARE the None discriminants the V6 decoder reads.
pub fn encode_v6_image(legacy: &LegacyVaultDecoded, dexter_authority: Pubkey) -> Result<Vec<u8>> {
    // i64 → u32 with explicit clamp. Negative (meaningless) → 0; oversized
    // (impossible live, but cheap to be exact) → u32::MAX.
    let cooling_off_seconds: u32 = legacy.cooling_off_seconds.clamp(0, u32::MAX as i64) as u32;

    let mut identity_claim = [0u8; 32];
    identity_claim[0..16].copy_from_slice(&legacy.supabase_user_id);

    let v6 = Vault {
        version: VAULT_VERSION_V6,
        bump: legacy.bump,
        passkey_pubkey: legacy.passkey_pubkey,
        swig_address: legacy.swig_address,
        cooling_off_seconds,
        pending_voucher_count: legacy.pending_voucher_count,
        pending_withdrawal: legacy.pending_withdrawal.clone(),
        identity_claim,
        dexter_authority,
        live_session_count: 0,
        outstanding_locked_amount: 0,
        total_crystallized_amount: 0,
        total_settled_amount: 0,
        borrowed: 0,
        standby_backer: None,
        standby_cap: 0,
        borrow_recovery_at: None,
    };

    let target = 8 + Vault::INIT_SPACE;
    let mut out = Vec::with_capacity(target);
    out.extend_from_slice(Vault::DISCRIMINATOR);
    v6.serialize(&mut out)?;
    require!(out.len() <= target, VaultError::UnsupportedVaultVersion);
    out.resize(target, 0);
    Ok(out)
}

pub fn handler(ctx: Context<MigrateLegacyToV6>, _args: MigrateLegacyToV6Args) -> Result<()> {
    let vault_ai = &ctx.accounts.vault;

    // ---- (1) frozen decode (validates length + discriminator + layout) -----
    let legacy = {
        let data = vault_ai.try_borrow_data()?;
        decode_legacy_vault(&data)?
    }; // drop the data borrow before resize takes a mut borrow

    // ---- (2) authority-gate, resolving the V6 dexter_authority -------------
    let new_authority = match legacy.stored_authority {
        // V1.5 (183 B): the stored authority must sign and is PRESERVED.
        Some(stored) => {
            require!(
                ctx.accounts.authority.key() == stored,
                VaultError::PasskeyVerificationFailed
            );
            stored
        }
        // V1 (151 B): no on-chain authority record exists — gate on the
        // hardcoded admin and STAMP it as the new authority (see the
        // LEGACY_MIGRATE_ADMIN doc for why this claim is deliberate).
        None => {
            require!(
                ctx.accounts.authority.key() == LEGACY_MIGRATE_ADMIN,
                VaultError::PasskeyVerificationFailed
            );
            LEGACY_MIGRATE_ADMIN
        }
    };

    // ---- (3) re-encode as the current V6 image (padded to full size) -------
    let image = encode_v6_image(&legacy, new_authority)?;
    let new_size = image.len(); // == 8 + Vault::INIT_SPACE by construction

    // ---- (4) GROW: rent top-up + resize (mirrors migrate_v2_to_v3) ---------
    // 151/183 → 279 is always a grow; the payer funds the rent delta so the
    // enlarged account stays rent-exempt.
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
    vault_ai.resize(new_size)?;

    // ---- (5) write the padded V6 image over the whole account --------------
    {
        let mut data = vault_ai.try_borrow_mut_data()?;
        require!(data.len() == new_size, VaultError::UnsupportedVaultVersion);
        data.copy_from_slice(&image);
    }

    Ok(())
}

// =============================================================================
// Unit tests — REAL mainnet fixture bytes + adversarial synthetics.
//
// First #[cfg(test)] module in programs/: the decode/encode halves above are
// pure functions over byte slices precisely so they can be proven here against
// the actual stranded on-chain accounts, with no validator in the loop.
// =============================================================================
#[cfg(test)]
mod tests {
    use super::*;
    use std::str::FromStr;

    /// Minimal hex decoder so the fixtures need no extra dev-dependency.
    fn hx(s: &str) -> Vec<u8> {
        assert!(s.len() % 2 == 0, "odd hex length");
        (0..s.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
            .collect()
    }

    // ── REAL on-chain fixtures ───────────────────────────────────────────────
    // Fetched 2026-06-10 via Helius mainnet RPC getMultipleAccounts at slot
    // 425502493 (base64 → hex, verbatim). Both owned by this program
    // (Hg3wRaydFtJhYrdvYrKECacpJYDsC9Px7yKmpncj2fhc).

    /// 7FE9VUeabi3sF8wUABV7F3eyvEi1ekDbER9k5JBYrWAi — 183-byte V1.5 (REAL USER).
    /// Known values: bump 254, passkey 0x03…, swig B4hHHypBQ7Lu… (carries the
    /// 1-USDC binding), cooling 0, pvc 0, pending None, authority 3SWJTQ4FB….
    const FIX_183_HEX: &str = "d308e82b02987577fe03691f8c899a761203f31174ec1f789b9393fe8177cdd38a1f4b4d297cef53bf409587284f51c1d68e96dbff735af6835728109830e4413777aeeb5e8ac8fc4cfd0000000000000000000000000077d8550d7f3153eb775ecc9c3f77eb012440065752b79ff81d90468e52b49d5d48bb31a5002088d18ad294dfec9296cb000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000";

    /// 4rCQW6yijKkiWrABxJHx26rpaGaLR83FJXerAbRL1tMP — 151-byte V1 (test relic).
    /// Known values: bump 252, passkey 0x03…, swig = all-zero pubkey
    /// (1111…1111 — never bound), cooling 86400 (NOT 0 — contradicts the
    /// "live values are all 0" briefing; fits u32 fine), pvc 0, pending None.
    const FIX_151_HEX: &str = "d308e82b02987577fc03dc00f401612078a47793185c1ad873b6b42a1050c407f43d806611b71aa04692000000000000000000000000000000000000000000000000000000000000000080510100000000000000000000cc49ff61fb72ac2c3c2e974ad1dab60e000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000";

    const FIX_183_SWIG: &str = "B4hHHypBQ7LuEXSdT3e9sWGGbbywcGSocju1C8VD3NFE";
    const FIX_183_AUTHORITY: &str = "3SWJTQ4FBDveFQGQbqd8pxyBxa2PKqkega4QzxgPMWMG";
    const FIX_183_PASSKEY_HEX: &str =
        "03691f8c899a761203f31174ec1f789b9393fe8177cdd38a1f4b4d297cef53bf40";
    const FIX_183_UUID_HEX: &str = "77d8550d7f3153eb775ecc9c3f77eb01";
    const FIX_151_PASSKEY_HEX: &str =
        "03dc00f401612078a47793185c1ad873b6b42a1050c407f43d806611b71aa04692";
    const FIX_151_UUID_HEX: &str = "cc49ff61fb72ac2c3c2e974ad1dab60e";

    fn pk(s: &str) -> Pubkey {
        Pubkey::from_str(s).unwrap()
    }

    // ── decode: the two REAL fixtures, every preserved field ────────────────

    #[test]
    fn decode_real_183_fixture() {
        let buf = hx(FIX_183_HEX);
        assert_eq!(buf.len(), LEGACY_V15_LEN);
        let d = decode_legacy_vault(&buf).expect("183-byte fixture must decode");
        assert_eq!(d.bump, 254);
        assert_eq!(d.passkey_pubkey[0], 0x03);
        assert_eq!(d.passkey_pubkey.to_vec(), hx(FIX_183_PASSKEY_HEX));
        assert_eq!(d.swig_address, pk(FIX_183_SWIG));
        assert_eq!(d.cooling_off_seconds, 0);
        assert_eq!(d.pending_voucher_count, 0);
        assert!(d.pending_withdrawal.is_none());
        assert_eq!(d.supabase_user_id.to_vec(), hx(FIX_183_UUID_HEX));
        assert_eq!(d.stored_authority, Some(pk(FIX_183_AUTHORITY)));
    }

    #[test]
    fn decode_real_151_fixture() {
        let buf = hx(FIX_151_HEX);
        assert_eq!(buf.len(), LEGACY_V1_LEN);
        let d = decode_legacy_vault(&buf).expect("151-byte fixture must decode");
        assert_eq!(d.bump, 252);
        assert_eq!(d.passkey_pubkey[0], 0x03);
        assert_eq!(d.passkey_pubkey.to_vec(), hx(FIX_151_PASSKEY_HEX));
        assert_eq!(d.swig_address, Pubkey::default()); // never bound to a swig
        assert_eq!(d.cooling_off_seconds, 86_400); // real value — NOT 0
        assert_eq!(d.pending_voucher_count, 0);
        assert!(d.pending_withdrawal.is_none());
        assert_eq!(d.supabase_user_id.to_vec(), hx(FIX_151_UUID_HEX));
        assert_eq!(d.stored_authority, None); // V1 has no authority field
    }

    // ── re-encode: round-trip both fixtures through the CURRENT Vault struct ─

    #[test]
    fn reencode_183_roundtrips_through_v6_vault() {
        let d = decode_legacy_vault(&hx(FIX_183_HEX)).unwrap();
        let authority = d.stored_authority.unwrap(); // the 183 gate preserves it
        let image = encode_v6_image(&d, authority).unwrap();
        assert_eq!(image.len(), 8 + Vault::INIT_SPACE);
        assert_eq!(image.len(), 279); // the documented V6 account size

        let v6 = Vault::try_deserialize(&mut image.as_slice())
            .expect("padded image must decode through the CURRENT Vault struct");
        assert_eq!(v6.version, VAULT_VERSION_V6);
        assert_eq!(v6.bump, 254);
        assert_eq!(v6.passkey_pubkey.to_vec(), hx(FIX_183_PASSKEY_HEX));
        assert_eq!(v6.swig_address, pk(FIX_183_SWIG)); // the 1-USDC binding survives
        assert_eq!(v6.cooling_off_seconds, 0);
        assert_eq!(v6.pending_voucher_count, 0);
        assert!(v6.pending_withdrawal.is_none());
        assert_eq!(v6.identity_claim[0..16].to_vec(), hx(FIX_183_UUID_HEX));
        assert_eq!(v6.identity_claim[16..32], [0u8; 16]); // zero-padded tail
        assert_eq!(v6.dexter_authority, pk(FIX_183_AUTHORITY)); // PRESERVED
        // every modern-era field neutral
        assert_eq!(v6.live_session_count, 0);
        assert_eq!(v6.outstanding_locked_amount, 0);
        assert_eq!(v6.total_crystallized_amount, 0);
        assert_eq!(v6.total_settled_amount, 0);
        assert_eq!(v6.borrowed, 0);
        assert!(v6.standby_backer.is_none());
        assert_eq!(v6.standby_cap, 0);
        assert!(v6.borrow_recovery_at.is_none());
    }

    #[test]
    fn reencode_151_stamps_admin_and_roundtrips() {
        let d = decode_legacy_vault(&hx(FIX_151_HEX)).unwrap();
        assert!(d.stored_authority.is_none()); // → the handler stamps the admin
        let image = encode_v6_image(&d, LEGACY_MIGRATE_ADMIN).unwrap();
        assert_eq!(image.len(), 8 + Vault::INIT_SPACE);

        let v6 = Vault::try_deserialize(&mut image.as_slice()).unwrap();
        assert_eq!(v6.version, VAULT_VERSION_V6);
        assert_eq!(v6.bump, 252);
        assert_eq!(v6.passkey_pubkey.to_vec(), hx(FIX_151_PASSKEY_HEX));
        assert_eq!(v6.swig_address, Pubkey::default());
        assert_eq!(v6.cooling_off_seconds, 86_400); // i64 86400 → u32 86400
        assert_eq!(v6.pending_voucher_count, 0);
        assert!(v6.pending_withdrawal.is_none());
        assert_eq!(v6.identity_claim[0..16].to_vec(), hx(FIX_151_UUID_HEX));
        assert_eq!(v6.identity_claim[16..32], [0u8; 16]);
        assert_eq!(v6.dexter_authority, LEGACY_MIGRATE_ADMIN); // STAMPED
        assert_eq!(v6.live_session_count, 0);
        assert_eq!(v6.borrowed, 0);
        assert!(v6.standby_backer.is_none());
    }

    /// The deploy-night lesson, asserted: the un-padded Borsh payload of a
    /// None-bearing vault is STRICTLY SHORTER than INIT_SPACE (each None
    /// option serializes as 1 byte, not 1 + size). `== INIT_SPACE` would
    /// reject every real vault.
    #[test]
    fn unpadded_payload_is_shorter_than_init_space() {
        let d = decode_legacy_vault(&hx(FIX_183_HEX)).unwrap();
        let mut raw = Vec::new();
        raw.extend_from_slice(Vault::DISCRIMINATOR);
        let v6 = Vault::try_deserialize(
            &mut encode_v6_image(&d, LEGACY_MIGRATE_ADMIN).unwrap().as_slice(),
        )
        .unwrap();
        v6.serialize(&mut raw).unwrap();
        assert!(raw.len() < 8 + Vault::INIT_SPACE);
        assert!(raw.len() <= 8 + Vault::INIT_SPACE); // the require! the handler uses
    }

    // ── adversarial: wrong disc / wrong length / truncated ──────────────────

    #[test]
    fn rejects_wrong_discriminator() {
        let mut buf = hx(FIX_151_HEX);
        buf[0] ^= 0xff;
        assert!(decode_legacy_vault(&buf).is_err());
    }

    #[test]
    fn rejects_truncated_and_wrong_length_buffers() {
        let full = hx(FIX_183_HEX);
        // truncated → clean error, no panic
        assert!(decode_legacy_vault(&full[..150]).is_err());
        assert!(decode_legacy_vault(&full[..8]).is_err());
        assert!(decode_legacy_vault(&[]).is_err());
        // off-by-one around both gates
        assert!(decode_legacy_vault(&full[..182]).is_err());
        assert!(decode_legacy_vault(&full[..152]).is_err());
        // a CURRENT 279-byte V6 account must never pass the legacy gate
        let mut modern = vec![0u8; 279];
        modern[0..8].copy_from_slice(Vault::DISCRIMINATOR);
        assert!(decode_legacy_vault(&modern).is_err());
    }

    // ── adversarial: synthetic Some-withdrawal — the +48 shift ──────────────

    /// Build a synthetic 183-byte V1.5 buffer whose pending_withdrawal is
    /// Some: the Some payload (+48) consumes the zero slack exactly, shifting
    /// supabase_user_id 87→135 and dexter_authority 103(+16)→151. The decoder
    /// must carry the withdrawal AND still land the shifted fields.
    #[test]
    fn decodes_synthetic_some_withdrawal_with_shift() {
        let base = hx(FIX_183_HEX);
        let dest = pk(FIX_183_AUTHORITY); // any pubkey works as destination
        let mut buf = Vec::with_capacity(LEGACY_V15_LEN);
        buf.extend_from_slice(&base[..86]); // disc..pending_voucher_count
        buf.push(1); // Some tag
        buf.extend_from_slice(&5_000_000u64.to_le_bytes()); // amount
        buf.extend_from_slice(dest.as_ref()); // destination
        buf.extend_from_slice(&1_750_000_000i64.to_le_bytes()); // requested_at
        buf.extend_from_slice(&base[87..103]); // uuid (real fixture bytes)
        buf.extend_from_slice(&base[103..135]); // authority (real fixture bytes)
        assert_eq!(buf.len(), LEGACY_V15_LEN); // Some eats the slack exactly

        let d = decode_legacy_vault(&buf).unwrap();
        let w = d.pending_withdrawal.as_ref().expect("must carry the Some");
        assert_eq!(w.amount, 5_000_000);
        assert_eq!(w.destination, dest);
        assert_eq!(w.requested_at, 1_750_000_000);
        // the +48-shifted tail fields still decode to the fixture's values
        assert_eq!(d.supabase_user_id.to_vec(), hx(FIX_183_UUID_HEX));
        assert_eq!(d.stored_authority, Some(pk(FIX_183_AUTHORITY)));

        // and the withdrawal is CARRIED through the V6 re-encode
        let image = encode_v6_image(&d, d.stored_authority.unwrap()).unwrap();
        let v6 = Vault::try_deserialize(&mut image.as_slice()).unwrap();
        let cw = v6.pending_withdrawal.expect("carried into V6");
        assert_eq!(cw.amount, 5_000_000);
        assert_eq!(cw.destination, dest);
        assert_eq!(cw.requested_at, 1_750_000_000);
    }

    /// A junk Option tag (neither 0 nor 1) must fail Borsh cleanly, not panic.
    #[test]
    fn rejects_junk_option_tag() {
        let mut buf = hx(FIX_183_HEX);
        buf[86] = 7;
        assert!(decode_legacy_vault(&buf).is_err());
    }

    // ── conversion: i64 cooling_off clamps into u32 ──────────────────────────

    #[test]
    fn cooling_off_clamps_into_u32() {
        // over u32::MAX → clamps to u32::MAX
        let mut buf = hx(FIX_151_HEX);
        let big: i64 = u32::MAX as i64 + 12_345;
        buf[74..82].copy_from_slice(&big.to_le_bytes());
        let d = decode_legacy_vault(&buf).unwrap();
        assert_eq!(d.cooling_off_seconds, big);
        let image = encode_v6_image(&d, LEGACY_MIGRATE_ADMIN).unwrap();
        let v6 = Vault::try_deserialize(&mut image.as_slice()).unwrap();
        assert_eq!(v6.cooling_off_seconds, u32::MAX);

        // negative (meaningless) → clamps to 0
        let mut buf = hx(FIX_151_HEX);
        buf[74..82].copy_from_slice(&(-1i64).to_le_bytes());
        let d = decode_legacy_vault(&buf).unwrap();
        let image = encode_v6_image(&d, LEGACY_MIGRATE_ADMIN).unwrap();
        let v6 = Vault::try_deserialize(&mut image.as_slice()).unwrap();
        assert_eq!(v6.cooling_off_seconds, 0);
    }
}
