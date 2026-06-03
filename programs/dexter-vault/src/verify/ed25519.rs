//! Ed25519 sibling-instruction introspection for session-key voucher proofs.
//!
//! When a session key signs a voucher off-chain (via tweetnacl), the buyer's
//! SDK ships a tx that includes Solana's built-in Ed25519 sigverify precompile
//! as the FIRST instruction. The precompile itself verifies the signature
//! cryptographically; this helper proves that the precompile verified the
//! SPECIFIC (pubkey, message) pair we care about — i.e. that the buyer's
//! registered session key actually signed THIS voucher, not a different one.
//!
//! Layout of the Solana Ed25519 precompile data (per
//! solana-sdk/sdk/src/ed25519_instruction.rs):
//!   [0]      num_signatures (u8)
//!   [1]      padding (u8)
//!   [2..16]  signature_offsets {                       // 14 bytes per sig
//!              signature_offset:           u16,
//!              signature_instruction_index: u16,
//!              public_key_offset:          u16,
//!              public_key_instruction_index: u16,
//!              message_data_offset:        u16,
//!              message_data_size:          u16,
//!              message_instruction_index:  u16,
//!            }
//!   [16..]   contiguous data: pubkey(32) || signature(64) || message
//!
//! This layout matches the SIMD-0075 secp256r1 precompile byte-for-byte except
//! the pubkey is 32 bytes (not 33).

use anchor_lang::prelude::*;
use anchor_lang::solana_program::sysvar::instructions::{
    load_current_index_checked, load_instruction_at_checked,
};

use crate::state::VaultError;

/// Solana Ed25519 sigverify precompile program ID.
pub const ED25519_VERIFY_PROGRAM_ID: Pubkey =
    anchor_lang::pubkey!("Ed25519SigVerify111111111111111111111111111");

const ED25519_PUBKEY_LEN: usize = 32;
const ED25519_SIG_LEN: usize = 64;
const SIGNATURE_OFFSETS_SERIALIZED_SIZE: usize = 14;
const DATA_START: usize = 2;

/// Confirms the preceding instruction was an Ed25519 sigverify call with
/// EXACTLY the given pubkey and message. The precompile already validated the
/// signature; this introspection just proves the (pubkey, message) match what
/// the vault expects.
///
/// Returns Ok(()) iff every offsets/value check passes.
pub fn verify_session_signed(
    instructions_sysvar: &AccountInfo,
    expected_pubkey: &[u8; ED25519_PUBKEY_LEN],
    expected_message: &[u8],
) -> Result<()> {
    let current_index = load_current_index_checked(instructions_sysvar)?;
    require!(current_index > 0, VaultError::InvalidVoucherSignature);

    let prev_ix = load_instruction_at_checked(
        (current_index as usize) - 1,
        instructions_sysvar,
    )?;

    require!(
        prev_ix.program_id == ED25519_VERIFY_PROGRAM_ID,
        VaultError::InvalidVoucherSignature
    );

    let data = prev_ix.data;
    require!(
        data.len() >= DATA_START + SIGNATURE_OFFSETS_SERIALIZED_SIZE,
        VaultError::InvalidVoucherSignature
    );

    let num_signatures = data[0];
    require!(num_signatures >= 1, VaultError::InvalidVoucherSignature);

    let off = &data[DATA_START..DATA_START + SIGNATURE_OFFSETS_SERIALIZED_SIZE];
    let signature_offset = u16::from_le_bytes([off[0], off[1]]) as usize;
    let signature_instruction_index = u16::from_le_bytes([off[2], off[3]]);
    let public_key_offset = u16::from_le_bytes([off[4], off[5]]) as usize;
    let public_key_instruction_index = u16::from_le_bytes([off[6], off[7]]);
    let message_data_offset = u16::from_le_bytes([off[8], off[9]]) as usize;
    let message_data_size = u16::from_le_bytes([off[10], off[11]]) as usize;
    let message_instruction_index = u16::from_le_bytes([off[12], off[13]]);

    // All three pieces (pubkey, sig, message) must live in this same
    // precompile instruction — not pointed at some other instruction's data
    // (which would let a caller smuggle in an unverified message).
    require!(
        signature_instruction_index == public_key_instruction_index
            && public_key_instruction_index == message_instruction_index,
        VaultError::InvalidVoucherSignature
    );

    require!(
        public_key_offset + ED25519_PUBKEY_LEN <= data.len(),
        VaultError::InvalidVoucherSignature
    );
    require!(
        message_data_offset + message_data_size <= data.len(),
        VaultError::InvalidVoucherSignature
    );

    let actual_pubkey = &data[public_key_offset..public_key_offset + ED25519_PUBKEY_LEN];
    let actual_message = &data[message_data_offset..message_data_offset + message_data_size];

    require!(
        actual_pubkey == expected_pubkey,
        VaultError::InvalidVoucherSignature
    );
    require!(
        actual_message == expected_message,
        VaultError::InvalidVoucherSignature
    );

    let _ = ED25519_SIG_LEN;
    let _ = signature_offset;
    Ok(())
}
