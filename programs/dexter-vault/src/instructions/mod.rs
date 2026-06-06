pub mod initialize_vault;
pub mod set_swig;
pub mod settle_voucher;
pub mod request_withdrawal;
pub mod finalize_withdrawal;
pub mod force_release;
pub mod rotate_passkey;
pub mod rotate_dexter_authority;
pub mod prove_passkey;
pub mod register_session_key;
pub mod revoke_session_key;
pub mod settle_tab_voucher;
pub mod set_swig_atomic;
pub mod migrate_v2_to_v3;
pub mod migrate_v3_to_v4;
pub mod lock_voucher;
pub mod transfer_lock_ownership;
pub mod settle_locked_voucher;
pub mod recover_abandoned_lock;
pub mod open_standby;
pub mod draw_credit;

// Glob re-exports are required by Anchor: the `#[program]` macro resolves the
// `#[derive(Accounts)]`-generated helper modules (`__client_accounts_*`,
// `__cpi_client_accounts_*`) through `instructions::*`, so the globs must stay.
// They also re-export each module's `handler` fn, and since every module names
// it `handler`, a *bare* `handler` is ambiguous — hence the warning. It is
// harmless here: lib.rs only ever calls handlers fully-qualified
// (`instructions::<module>::handler(...)`), so the ambiguous bare name is never
// resolved. Suppressed explicitly rather than left noisy.
#[allow(ambiguous_glob_reexports)]
pub use initialize_vault::*;
#[allow(ambiguous_glob_reexports)]
pub use set_swig::*;
#[allow(ambiguous_glob_reexports)]
pub use settle_voucher::*;
#[allow(ambiguous_glob_reexports)]
pub use request_withdrawal::*;
#[allow(ambiguous_glob_reexports)]
pub use finalize_withdrawal::*;
#[allow(ambiguous_glob_reexports)]
pub use force_release::*;
#[allow(ambiguous_glob_reexports)]
pub use rotate_passkey::*;
#[allow(ambiguous_glob_reexports)]
pub use rotate_dexter_authority::*;
#[allow(ambiguous_glob_reexports)]
pub use prove_passkey::*;
#[allow(ambiguous_glob_reexports)]
pub use register_session_key::*;
#[allow(ambiguous_glob_reexports)]
pub use revoke_session_key::*;
#[allow(ambiguous_glob_reexports)]
pub use settle_tab_voucher::*;
#[allow(ambiguous_glob_reexports)]
pub use set_swig_atomic::*;
#[allow(ambiguous_glob_reexports)]
pub use migrate_v2_to_v3::*;
#[allow(ambiguous_glob_reexports)]
pub use migrate_v3_to_v4::*;
#[allow(ambiguous_glob_reexports)]
pub use lock_voucher::*;
#[allow(ambiguous_glob_reexports)]
pub use transfer_lock_ownership::*;
#[allow(ambiguous_glob_reexports)]
pub use settle_locked_voucher::*;
#[allow(ambiguous_glob_reexports)]
pub use recover_abandoned_lock::*;
#[allow(ambiguous_glob_reexports)]
pub use open_standby::*;
#[allow(ambiguous_glob_reexports)]
pub use draw_credit::*;
