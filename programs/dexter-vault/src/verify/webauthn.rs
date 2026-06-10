//! WebAuthn-aware SIMD-0075 introspection.
//!
//! When a browser passkey signs an operation, the authenticator does NOT
//! sign the raw operation bytes. Per the WebAuthn spec, it signs:
//!
//! ```text
//!     authenticatorData || sha256(clientDataJSON)
//! ```
//!
//! where `clientDataJSON` is a JSON object the browser produces, of the form:
//!
//! ```text
//!     {"type":"webauthn.get","challenge":"<base64url>","origin":"https://dexter.cash",...}
//! ```
//!
//! and `challenge` is the value the relying party (dexter-api) passed to
//! `navigator.credentials.get({ challenge })`. For our vault, the challenge
//! is always `sha256(operation_message)` — a 32-byte digest that uniquely
//! identifies the action being authorized.
//!
//! This module's job:
//!   1. Confirm SIMD-0075 ran with `message = authenticatorData || sha256(clientDataJSON)`
//!   2. Parse `clientDataJSON` to extract the base64url challenge
//!   3. Decode the challenge and confirm it equals `sha256(expected_operation_message)`
//!
//! The result: the vault knows the user's passkey signed *this specific
//! operation*, with cryptographic guarantees from the SIMD-0075 precompile.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::sysvar::instructions::{
    load_current_index_checked, load_instruction_at_checked,
};
use solana_sha256_hasher::hashv;

use crate::state::VaultError;

/// SIMD-0075 precompile program ID.
pub const SECP256R1_VERIFY_PROGRAM_ID: Pubkey =
    anchor_lang::pubkey!("Secp256r1SigVerify1111111111111111111111111");

const SIGNATURE_SERIALIZED_SIZE: usize = 64;
const COMPRESSED_PUBKEY_SERIALIZED_SIZE: usize = 33;
const SIGNATURE_OFFSETS_SERIALIZED_SIZE: usize = 14;
const DATA_START: usize = 2;

/// WebAuthn `authenticatorData` minimum length: 32 (rpIdHash) + 1 (flags) + 4 (signCount).
const AUTH_DATA_MIN_LEN: usize = 37;

/// Verifies that the user's passkey signed the given operation message.
///
/// Inputs:
///   - `instructions_sysvar`: the sysvar account, address-constrained by the caller
///   - `expected_pubkey`: the vault's stored 33-byte SEC1 compressed P-256 pubkey
///   - `client_data_json`: the JSON blob the browser produced during the ceremony
///   - `authenticator_data`: the WebAuthn authenticator output (37+ bytes)
///   - `expected_operation_message`: the bytes whose sha256 must equal the
///     base64url-decoded `challenge` field inside `client_data_json`
///
/// Returns Ok(()) iff every check passes. The precompile already validated
/// the signature — this helper proves authorship over a specific operation.
pub fn verify_passkey_signed(
    instructions_sysvar: &AccountInfo,
    expected_pubkey: &[u8; COMPRESSED_PUBKEY_SERIALIZED_SIZE],
    client_data_json: &[u8],
    authenticator_data: &[u8],
    expected_operation_message: &[u8],
) -> Result<()> {
    require!(
        authenticator_data.len() >= AUTH_DATA_MIN_LEN,
        VaultError::PasskeyVerificationFailed
    );

    // The message SIMD-0075 verified: authenticatorData || sha256(clientDataJSON).
    let client_data_hash = hashv(&[client_data_json]);
    let mut composed = Vec::with_capacity(authenticator_data.len() + 32);
    composed.extend_from_slice(authenticator_data);
    composed.extend_from_slice(client_data_hash.as_ref());

    introspect_simd_0075(instructions_sysvar, expected_pubkey, &composed)?;

    // Now parse clientDataJSON and confirm the challenge equals
    // sha256(expected_operation_message).
    let expected_challenge = hashv(&[expected_operation_message]);
    let challenge_bytes = extract_challenge_from_client_data(client_data_json)?;
    require!(
        challenge_bytes.as_slice() == expected_challenge.as_ref(),
        VaultError::PasskeyVerificationFailed
    );

    Ok(())
}

/// Confirms that the previous instruction was a SIMD-0075 sigverify call
/// with exactly the given pubkey and message. The precompile already checked
/// the signature; this function only checks authorship.
fn introspect_simd_0075(
    instructions_sysvar: &AccountInfo,
    expected_pubkey: &[u8; COMPRESSED_PUBKEY_SERIALIZED_SIZE],
    expected_message: &[u8],
) -> Result<()> {
    let current_index = load_current_index_checked(instructions_sysvar)?;
    require!(current_index > 0, VaultError::PasskeyVerificationFailed);

    let prev_ix = load_instruction_at_checked(
        (current_index as usize) - 1,
        instructions_sysvar,
    )?;

    require!(
        prev_ix.program_id == SECP256R1_VERIFY_PROGRAM_ID,
        VaultError::PasskeyVerificationFailed
    );

    let data = prev_ix.data;
    require!(
        data.len() >= DATA_START + SIGNATURE_OFFSETS_SERIALIZED_SIZE,
        VaultError::PasskeyVerificationFailed
    );

    let num_signatures = data[0];
    require!(num_signatures >= 1, VaultError::PasskeyVerificationFailed);

    let off = &data[DATA_START..DATA_START + SIGNATURE_OFFSETS_SERIALIZED_SIZE];
    let signature_offset = u16::from_le_bytes([off[0], off[1]]) as usize;
    let signature_instruction_index = u16::from_le_bytes([off[2], off[3]]);
    let public_key_offset = u16::from_le_bytes([off[4], off[5]]) as usize;
    let public_key_instruction_index = u16::from_le_bytes([off[6], off[7]]);
    let message_data_offset = u16::from_le_bytes([off[8], off[9]]) as usize;
    let message_data_size = u16::from_le_bytes([off[10], off[11]]) as usize;
    let message_instruction_index = u16::from_le_bytes([off[12], off[13]]);

    require!(
        signature_instruction_index == public_key_instruction_index
            && public_key_instruction_index == message_instruction_index,
        VaultError::PasskeyVerificationFailed
    );

    require!(
        public_key_offset + COMPRESSED_PUBKEY_SERIALIZED_SIZE <= data.len(),
        VaultError::PasskeyVerificationFailed
    );
    require!(
        message_data_offset + message_data_size <= data.len(),
        VaultError::PasskeyVerificationFailed
    );

    let actual_pubkey = &data[public_key_offset..public_key_offset + COMPRESSED_PUBKEY_SERIALIZED_SIZE];
    let actual_message = &data[message_data_offset..message_data_offset + message_data_size];

    require!(
        actual_pubkey == expected_pubkey,
        VaultError::PasskeyVerificationFailed
    );
    require!(
        actual_message == expected_message,
        VaultError::PasskeyVerificationFailed
    );

    let _ = SIGNATURE_SERIALIZED_SIZE;
    let _ = signature_offset;
    Ok(())
}

/// Locates the `challenge` field in clientDataJSON and returns its
/// base64url-decoded bytes. Implementation is a minimal-footprint scanner —
/// we don't pull in serde_json on chain. Expected payload shape:
///
/// ```text
///     {"type":"webauthn.get","challenge":"<base64url>","origin":"...",...}
/// ```
///
/// Field order is not guaranteed by the WebAuthn spec, but each value is
/// always a JSON string. We scan for `"challenge":"` and read until the
/// next unescaped `"`.
fn extract_challenge_from_client_data(client_data_json: &[u8]) -> Result<Vec<u8>> {
    const KEY: &[u8] = b"\"challenge\":\"";
    let mut i = 0usize;
    let end = client_data_json.len();
    let key_pos = loop {
        if i + KEY.len() > end {
            return err!(VaultError::PasskeyVerificationFailed);
        }
        if &client_data_json[i..i + KEY.len()] == KEY {
            break i + KEY.len();
        }
        i += 1;
    };

    // Read until closing quote. The browser's clientDataJSON does not include
    // backslash escapes inside the challenge value (it's base64url-encoded —
    // only [A-Za-z0-9_-] characters), so we don't need to handle escapes.
    let mut j = key_pos;
    while j < end && client_data_json[j] != b'"' {
        j += 1;
    }
    if j >= end {
        return err!(VaultError::PasskeyVerificationFailed);
    }

    base64url_decode(&client_data_json[key_pos..j])
}

/// Minimal base64url decoder. Accepts `A-Z`, `a-z`, `0-9`, `-`, `_`, with
/// optional `=` padding (browsers usually omit padding from the WebAuthn
/// challenge field).
fn base64url_decode(input: &[u8]) -> Result<Vec<u8>> {
    let mut buf: u32 = 0;
    let mut bits: u32 = 0;
    let mut out = Vec::with_capacity((input.len() * 3) / 4 + 2);
    for &b in input {
        let v: u32 = match b {
            b'A'..=b'Z' => (b - b'A') as u32,
            b'a'..=b'z' => (b - b'a' + 26) as u32,
            b'0'..=b'9' => (b - b'0' + 52) as u32,
            b'-' => 62,
            b'_' => 63,
            b'=' => break,
            _ => return err!(VaultError::PasskeyVerificationFailed),
        };
        buf = (buf << 6) | v;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push(((buf >> bits) & 0xff) as u8);
        }
    }
    Ok(out)
}
