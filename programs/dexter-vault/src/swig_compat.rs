//! Vendored byte-layout helpers from anagrambuild/swig-wallet @
//! c2e8eb4dc564c52a27cfcb9ed534db14c350c6c6 (workspace v1.4.0).
//!
//! Original sources:
//!   - program/src/instruction.rs        (SwigInstruction enum)
//!   - program/src/actions/create_v1.rs  (CreateV1Args)
//!   - program/src/actions/add_authority_v1.rs (AddAuthorityV1Args)
//!   - interface/src/lib.rs              (ClientAction::write)
//!
//! Licensing: original is AGPL-3.0. Vendored because swig-interface drags in
//! host-only solana-sdk transitives (getrandom 0.3) that won't compile to
//! SBF, and the Args structs live in the swig program crate (also host-only).
//! See docs/superpowers/plans/2026-06-04-set-swig-atomic.md for context.
//!
//! Only the byte-emitting code paths used by set_swig_atomic are copied.
//! Each on-chain struct is `#[repr(C, align(8))]` with `NoPadding`, matching
//! the deployed Swig program's wire format byte-for-byte. Drift is structurally
//! impossible: the Swig program reads back exactly these bytes via its own
//! `Transmutable::load_unchecked`, so any layout change would have to land in
//! both the program AND here, and the parity tests in @dexterai/vault would
//! catch a TS-side mismatch.

use anchor_lang::prelude::*;
use swig_state::action::{
    all::All, manage_authority::ManageAuthority, program_all::ProgramAll, token_limit::TokenLimit,
    Action, Permission,
};
use swig_state::authority::AuthorityType;
use swig_state::{IntoBytes, Transmutable};

/// SwigInstruction discriminator — `#[repr(u16)]` in the source.
/// CreateV1 = 0, AddAuthorityV1 = 1. We only need these two.
pub const SWIG_IX_CREATE_V1: u16 = 0;
pub const SWIG_IX_ADD_AUTHORITY_V1: u16 = 1;

/// Mirror of `swig::actions::create_v1::CreateV1Args` (program/src/actions/create_v1.rs).
/// Same `#[repr(C, align(8))]`, same field order, same field types — produces
/// byte-identical output to the upstream struct's `IntoBytes` impl.
#[repr(C, align(8))]
#[derive(Clone, Copy)]
pub struct CreateV1ArgsCompat {
    /// Discriminator slot — u16 because SwigInstruction is `#[repr(u16)]`.
    discriminator: u16,
    pub authority_type: u16,
    pub authority_data_len: u16,
    pub bump: u8,
    pub wallet_address_bump: u8,
    pub id: [u8; 32],
}

impl CreateV1ArgsCompat {
    pub const LEN: usize = core::mem::size_of::<Self>();

    pub fn new(
        id: [u8; 32],
        bump: u8,
        authority_type: AuthorityType,
        authority_data_len: u16,
        wallet_address_bump: u8,
    ) -> Self {
        Self {
            discriminator: SWIG_IX_CREATE_V1,
            authority_type: authority_type_as_u16(&authority_type),
            authority_data_len,
            bump,
            wallet_address_bump,
            id,
        }
    }

    pub fn as_bytes(&self) -> &[u8] {
        unsafe { core::slice::from_raw_parts(self as *const Self as *const u8, Self::LEN) }
    }
}

/// Mirror of `swig::actions::add_authority_v1::AddAuthorityV1Args`.
#[repr(C, align(8))]
#[derive(Clone, Copy)]
pub struct AddAuthorityV1ArgsCompat {
    discriminator: u16,
    pub new_authority_data_len: u16,
    pub actions_data_len: u16,
    pub new_authority_type: u16,
    pub num_actions: u8,
    _padding: [u8; 3],
    pub acting_role_id: u32,
}

impl AddAuthorityV1ArgsCompat {
    pub const LEN: usize = core::mem::size_of::<Self>();

    pub fn new(
        acting_role_id: u32,
        authority_type: AuthorityType,
        new_authority_data_len: u16,
        actions_data_len: u16,
        num_actions: u8,
    ) -> Self {
        Self {
            discriminator: SWIG_IX_ADD_AUTHORITY_V1,
            new_authority_data_len,
            actions_data_len,
            new_authority_type: authority_type_as_u16(&authority_type),
            num_actions,
            _padding: [0; 3],
            acting_role_id,
        }
    }

    pub fn as_bytes(&self) -> &[u8] {
        unsafe { core::slice::from_raw_parts(self as *const Self as *const u8, Self::LEN) }
    }
}

/// `AuthorityType` is `#[repr(u16)]` upstream but doesn't expose a public
/// `as u16` shortcut on the enum object (and matching exhaustively would be
/// noisy). The cleanest way: cast a reference to a u16 pointer, because the
/// `#[repr(u16)]` guarantees layout equivalence.
fn authority_type_as_u16(t: &AuthorityType) -> u16 {
    unsafe { *(t as *const AuthorityType as *const u16) }
}

/// Subset of swig-interface's `ClientAction` enum — only the 4 variants we
/// emit from set_swig_atomic. Each variant carries the action's inner struct.
pub enum ClientActionCompat {
    ManageAuthority(ManageAuthority),
    All(All),
    ProgramAll(ProgramAll),
    TokenLimit(TokenLimit),
}

impl ClientActionCompat {
    /// Byte layout (mirroring `interface/src/lib.rs::ClientAction::write`):
    ///   1. Action header: { permission: u16, length: u16, boundary: u32 }
    ///   2. Action body bytes (variant-specific)
    ///
    /// `boundary` = offset_in_actions_buffer + Action::LEN + body_len, exactly
    /// as upstream computes it (offset is the current buffer length before
    /// this action is appended).
    pub fn write(&self, data: &mut Vec<u8>) -> Result<()> {
        let (permission, length) = match self {
            ClientActionCompat::ManageAuthority(_) => {
                (Permission::ManageAuthority, ManageAuthority::LEN)
            }
            ClientActionCompat::All(_) => (Permission::All, All::LEN),
            ClientActionCompat::ProgramAll(_) => (Permission::ProgramAll, ProgramAll::LEN),
            ClientActionCompat::TokenLimit(_) => (Permission::TokenLimit, TokenLimit::LEN),
        };

        // Upstream `ClientAction::write` (interface/src/lib.rs) constructs
        // each action's header as `Action::new(permission, length,
        // boundary)` where boundary is the absolute end-offset of this
        // action inside the actions buffer (i.e. `offset + Action::LEN +
        // length`). swig-state's `Action::new` is public; we use it
        // directly to keep byte parity with upstream.
        let offset = data.len() as u32;
        let header = Action::new(
            permission,
            length as u16,
            offset + Action::LEN as u32 + length as u32,
        );
        let header_bytes = header
            .into_bytes()
            .map_err(|_| crate::state::VaultError::PasskeyVerificationFailed)?;
        data.extend_from_slice(header_bytes);

        let body_bytes: &[u8] = match self {
            ClientActionCompat::ManageAuthority(inner) => inner
                .into_bytes()
                .map_err(|_| crate::state::VaultError::PasskeyVerificationFailed)?,
            ClientActionCompat::All(inner) => inner
                .into_bytes()
                .map_err(|_| crate::state::VaultError::PasskeyVerificationFailed)?,
            ClientActionCompat::ProgramAll(inner) => inner
                .into_bytes()
                .map_err(|_| crate::state::VaultError::PasskeyVerificationFailed)?,
            ClientActionCompat::TokenLimit(inner) => inner
                .into_bytes()
                .map_err(|_| crate::state::VaultError::PasskeyVerificationFailed)?,
        };
        data.extend_from_slice(body_bytes);
        Ok(())
    }
}

/// Build the full instruction `data: Vec<u8>` for a Swig CreateV1 call.
///
/// Layout (matches `CreateInstruction::new` in interface/src/lib.rs):
///   CreateV1Args (LE) || authority_bytes || action_bytes_concat
pub fn build_create_v1_data(
    id: [u8; 32],
    swig_bump: u8,
    wallet_address_bump: u8,
    authority_type: AuthorityType,
    authority_bytes: &[u8],
    actions: &[ClientActionCompat],
) -> Result<Vec<u8>> {
    let args = CreateV1ArgsCompat::new(
        id,
        swig_bump,
        authority_type,
        authority_bytes.len() as u16,
        wallet_address_bump,
    );
    let mut write = Vec::with_capacity(CreateV1ArgsCompat::LEN + authority_bytes.len() + 64);
    write.extend_from_slice(args.as_bytes());
    write.extend_from_slice(authority_bytes);
    let mut action_bytes = Vec::new();
    for a in actions {
        a.write(&mut action_bytes)?;
    }
    write.append(&mut action_bytes);
    Ok(write)
}

/// Build the full instruction `data: Vec<u8>` for a Swig AddAuthorityV1 call
/// where the *acting* authority is an Ed25519 signer.
///
/// Layout (matches `AddAuthorityInstruction::new_with_ed25519_authority`):
///   AddAuthorityV1Args (LE) || new_authority_bytes || action_bytes_concat
///   || [authority_account_index: u8]
///
/// The trailing `authority_account_index` byte tells the Swig program which
/// account in the instruction's account list is the Ed25519 signer of the
/// acting role. With our 4-account layout
/// `[swig_account, payer, system_program, authority]`, the authority sits at
/// index 3 — same as upstream.
pub fn build_add_authority_v1_ed25519_acting_data(
    acting_role_id: u32,
    new_authority_type: AuthorityType,
    new_authority_bytes: &[u8],
    actions: &[ClientActionCompat],
    authority_account_index: u8,
) -> Result<Vec<u8>> {
    let mut action_bytes = Vec::new();
    let num_actions = actions.len() as u8;
    for a in actions {
        a.write(&mut action_bytes)?;
    }
    let args = AddAuthorityV1ArgsCompat::new(
        acting_role_id,
        new_authority_type,
        new_authority_bytes.len() as u16,
        action_bytes.len() as u16,
        num_actions,
    );
    let mut write = Vec::with_capacity(
        AddAuthorityV1ArgsCompat::LEN + new_authority_bytes.len() + action_bytes.len() + 1,
    );
    write.extend_from_slice(args.as_bytes());
    write.extend_from_slice(new_authority_bytes);
    write.extend_from_slice(&action_bytes);
    write.push(authority_account_index);
    Ok(write)
}
