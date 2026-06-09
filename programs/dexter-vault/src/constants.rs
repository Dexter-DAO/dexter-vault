use anchor_lang::prelude::*;

/// Mainnet-deployed Swig wallet program. The dexter-vault program references
/// this when an instruction's account list must satisfy Swig's ProgramExec
/// authority validator — e.g. finalize_withdrawal, whose account[0..1] of
/// [swig, swig_wallet_address] is anchored by Anchor seeds constraints whose
/// `seeds::program` is this id.
pub const SWIG_PROGRAM_ID: Pubkey = pubkey!("swigypWHEksbC64pWKwah1WTeh9JXwx8H1rJHLdbQMB");

/// Swig wallet address PDA seed prefix. The Swig program derives the wallet
/// address (the PDA that owns each Swig wallet's SPL token ATAs) as
/// `[b"swig-wallet-address", swig_pubkey]` under SWIG_PROGRAM_ID. Sourced
/// from /tmp/swig-wallet/state/src/swig.rs:50 (swig_wallet_address_seeds).
pub const SWIG_WALLET_ADDRESS_SEED: &[u8] = b"swig-wallet-address";

/// Session PDA seed prefix. A per-counterparty session lives at
/// `[SESSION_SEED, vault_pubkey, allowed_counterparty]` under this program.
/// One session per (vault, counterparty); re-register replaces in place.
pub const SESSION_SEED: &[u8] = b"session";
