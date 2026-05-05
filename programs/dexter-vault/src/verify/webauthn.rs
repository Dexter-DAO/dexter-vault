//! SIMD-0075 precompile introspection.
//!
//! The `Secp256r1SigVerify1111111111111111111111111` precompile validates
//! P-256 signatures at native speed during transaction processing. Programs
//! that want to enforce passkey-signed actions emit a *marker* instruction
//! (this program's own instruction) and place the precompile call directly
//! before it in the same transaction. The vault then reads the instruction
//! sysvar to confirm the preceding instruction was the precompile, parses
//! the offset table to locate the verified pubkey + message bytes, and
//! checks they match the values the marker is enforcing.
//!
//! If the precompile signature itself was invalid, the entire transaction
//! would have failed before this code runs. This helper only proves the
//! authorship — *which* pubkey verified *which* message.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::sysvar::instructions::{
    load_current_index_checked, load_instruction_at_checked,
};

use crate::state::VaultError;

/// SIMD-0075 precompile program ID.
pub const SECP256R1_VERIFY_PROGRAM_ID: Pubkey =
    anchor_lang::pubkey!("Secp256r1SigVerify1111111111111111111111111");

const SIGNATURE_SERIALIZED_SIZE: usize = 64;
const COMPRESSED_PUBKEY_SERIALIZED_SIZE: usize = 33;
const SIGNATURE_OFFSETS_SERIALIZED_SIZE: usize = 14;
const DATA_START: usize = 2; // num_signatures (u8) + padding (u8)

/// Verifies that the previous instruction in this transaction was a SIMD-0075
/// precompile call carrying the given pubkey + message. Returns Ok(()) only if
/// every byte matches; the precompile guarantees signature validity (or the tx
/// would have failed before reaching this code).
pub fn verify_passkey_signed(
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

    // Layout: [num_signatures: u8][padding: u8][offsets...][sig+pubkey+msg payload...]
    require!(
        data.len() >= DATA_START + SIGNATURE_OFFSETS_SERIALIZED_SIZE,
        VaultError::PasskeyVerificationFailed
    );

    let num_signatures = data[0];
    require!(num_signatures >= 1, VaultError::PasskeyVerificationFailed);

    // Parse the first offset struct (we only verify the first signature).
    let off = &data[DATA_START..DATA_START + SIGNATURE_OFFSETS_SERIALIZED_SIZE];
    let signature_offset = u16::from_le_bytes([off[0], off[1]]) as usize;
    let signature_instruction_index = u16::from_le_bytes([off[2], off[3]]);
    let public_key_offset = u16::from_le_bytes([off[4], off[5]]) as usize;
    let public_key_instruction_index = u16::from_le_bytes([off[6], off[7]]);
    let message_data_offset = u16::from_le_bytes([off[8], off[9]]) as usize;
    let message_data_size = u16::from_le_bytes([off[10], off[11]]) as usize;
    let message_instruction_index = u16::from_le_bytes([off[12], off[13]]);

    // 0xFFFF means "current instruction" per SIMD-0075. We expect the
    // signature, pubkey, and message to all live in the same precompile
    // instruction's data — i.e. either all 0xFFFF (current) or all equal.
    require!(
        signature_instruction_index == public_key_instruction_index
            && public_key_instruction_index == message_instruction_index,
        VaultError::PasskeyVerificationFailed
    );
    let _ = signature_offset; // signature not validated here — precompile already verified it

    // Bounds-check pubkey + message offsets.
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
    Ok(())
}
