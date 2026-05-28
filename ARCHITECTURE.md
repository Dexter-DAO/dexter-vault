# Architecture — dexter-vault

**Program:** `Hg3wRaydFtJhYrdvYrKECacpJYDsC9Px7yKmpncj2fhc` (Solana mainnet)
**Document status:** v1, 2026-05-10

This document is the end-to-end architecture reference for the dexter-vault Anchor program. It is intended for engineers integrating with the program, second/third implementers of the Open Tabs Standard (OTS), and reviewers building a mental model of the system.

For security properties and threat model, see [`SECURITY.md`](./SECURITY.md). For the broader Tab protocol and OTS standard, see [`docs/OTS-STANDARDS-PROPOSAL.md`](./docs/OTS-STANDARDS-PROPOSAL.md).

---

## 1. What dexter-vault is

dexter-vault is one Anchor program that defines a single account type (`Vault`) and five instructions. Its job is to gate withdrawal from a buyer's Swig smart-wallet such that the buyer cannot drain the wallet while spending authorizations ("tabs") are outstanding.

The program does **not** move funds. The actual movement of USDC from the buyer's Swig wallet happens via the Swig program, signed by a session role that Dexter operates. dexter-vault's job is bookkeeping and gating:

- Track the count of outstanding tabs (`pending_voucher_count`).
- Track a pending withdrawal intent (`pending_withdrawal`).
- Enforce that withdrawals only finalize when (count == 0) AND (cooling-off elapsed).

That's it. The program is small, deliberately. It is ~250 lines of Rust across five instructions plus a WebAuthn verification module.

---

## 2. System context

dexter-vault is one piece of a larger system. The full streaming-payment flow involves four on-chain programs and three off-chain services:

```
                ┌────────────────────────────────────────────────────────┐
                │                  Off-chain                              │
                │                                                         │
                │  ┌──────────────┐   ┌───────────────┐  ┌─────────────┐ │
                │  │ Buyer's      │   │ Dexter        │  │ Seller      │ │
                │  │ browser /    │   │ facilitator   │  │ API server  │ │
                │  │ agent        │   │ (Node.js)     │  │             │ │
                │  └──────┬───────┘   └───┬───────┬───┘  └──────▲──────┘ │
                │         │ passkey       │       │              │       │
                │         │ assertion     │       │ voucher      │       │
                │         │               │       │ signed       │       │
                └─────────┼───────────────┼───────┼──────────────┼───────┘
                          │               │       │              │
                          │               │       └──────────────┘
                          │               │       (off-chain HTTP)
                          ▼               ▼
                ┌────────────────────────────────────────────────────────┐
                │                  On-chain (Solana)                      │
                │                                                         │
                │  ┌──────────────┐   ┌───────────────┐                  │
                │  │ secp256r1    │   │ dexter-vault  │                  │
                │  │ sigverify    │◄──┤ (this prog.)  │                  │
                │  │ precompile   │   │               │                  │
                │  └──────────────┘   └───────┬───────┘                  │
                │                              │ bound to                 │
                │                              ▼                          │
                │                     ┌───────────────┐    ┌───────────┐ │
                │                     │ Swig smart-   │───►│ USDC      │ │
                │                     │ wallet        │    │ ATA       │ │
                │                     │ (Anagram)     │    │ (SPL)     │ │
                │                     └───────────────┘    └───────────┘ │
                │                                                         │
                └────────────────────────────────────────────────────────┘
```

| Component | Owner | Purpose |
|---|---|---|
| Buyer's browser / agent | User | Holds the WebAuthn passkey; constructs signed assertions for vault operations. |
| Dexter facilitator | Dexter (Node.js) | Operates the session role on buyer Swig wallets; issues off-chain vouchers; broadcasts settlement to chain. |
| Seller API server | Seller | Accepts off-chain vouchers, returns paid content. |
| dexter-vault | This program | Bookkeeping and withdrawal gate. |
| Swig smart-wallet | Anagram | Bounded-authority delegation. The buyer's funds live here. |
| secp256r1 sigverify | Solana Foundation | Verifies WebAuthn signatures on-chain. |
| USDC ATA | SPL Token program | The actual SPL token account holding the USDC. |

---

## 3. The vault account

### 3.1 Account schema

```rust
pub struct Vault {
    pub bump: u8,                            // PDA bump
    pub passkey_pubkey: [u8; 33],            // secp256r1 compressed P-256 pubkey
    pub swig_address: Pubkey,                // bound Swig (default = unbound)
    pub cooling_off_seconds: i64,            // withdrawal delay
    pub pending_voucher_count: u32,          // outstanding tabs counter
    pub pending_withdrawal: Option<PendingWithdrawal>,
    pub supabase_user_id: [u8; 16],          // off-chain user identifier
}

pub struct PendingWithdrawal {
    pub amount: u64,                         // atomic USDC
    pub destination: Pubkey,                 // where to send funds
    pub requested_at: i64,                   // unix timestamp from passkey assertion
}
```

### 3.2 PDA derivation

```rust
seeds = [b"vault", supabase_user_id]
program_id = Hg3wRaydFtJhYrdvYrKECacpJYDsC9Px7yKmpncj2fhc
```

One vault per Supabase user ID. The Supabase user ID is a 16-byte UUID identifying the user in Dexter's off-chain user-account system. Different products on top of dexter-vault could use different ID schemes — the PDA construction does not constrain the meaning of the 16 bytes, only that they uniquely identify a "vault owner."

### 3.3 Rent / size

```
8 (account discriminator)
+ 1 (bump)
+ 33 (passkey_pubkey)
+ 32 (swig_address)
+ 8 (cooling_off_seconds)
+ 4 (pending_voucher_count)
+ (1 + 48) (pending_withdrawal Option + PendingWithdrawal)
+ 16 (supabase_user_id)
= 151 bytes total
```

Rent-exempt deposit at current Solana rates: ~0.00154 SOL (~$0.30 at $200/SOL).

---

## 4. Instructions

### 4.1 `initialize_vault`

**Purpose:** Create a vault PDA for a user.

**Signature:**
```rust
pub fn initialize_vault(
    ctx: Context<InitializeVault>,
    args: InitializeVaultArgs,
) -> Result<()>

pub struct InitializeVaultArgs {
    pub passkey_pubkey: [u8; 33],
    pub cooling_off_seconds: i64,
    pub supabase_user_id: [u8; 16],
}
```

**Accounts:**
- `vault` (init, PDA `seeds=[b"vault", supabase_user_id]`)
- `payer` (signer, mut — pays rent)
- `system_program`

**Effects:**
- Allocates and initializes the Vault account.
- `swig_address` starts as `Pubkey::default()` — vault is "initialized but unbound."

**Who calls this:** Currently called by Dexter's API server (`dexter-api/src/routes/passkeyVault.ts`) on behalf of a user who just completed passkey enrollment. The payer is a fee-payer wallet operated by Dexter. The user is not required to hold SOL.

### 4.2 `set_swig`

**Purpose:** Bind a Swig smart-wallet to a vault. **One-shot — can only be called once per vault.**

**Signature:**
```rust
pub fn set_swig(
    ctx: Context<SetSwig>,
    args: SetSwigArgs,
) -> Result<()>

pub struct SetSwigArgs {
    pub swig_address: Pubkey,
    pub client_data_json: Vec<u8>,
    pub authenticator_data: Vec<u8>,
}
```

**Accounts:**
- `vault` (mut)
- `instructions_sysvar` (address-constrained to `sysvar::instructions::ID`)

**Pre-conditions:**
- `vault.swig_address == Pubkey::default()` (one-shot)
- Previous instruction must be a SIMD-0075 secp256r1 sigverify with:
  - pubkey == `vault.passkey_pubkey`
  - message == `authenticator_data || sha256(client_data_json)`
- `client_data_json.challenge` (base64url-decoded) == `sha256(b"set_swig" || swig_address_bytes)`

**Effects:**
- Sets `vault.swig_address = args.swig_address`.

**Transaction structure (typical):**
```
[0] SIMD-0075 sigverify (secp256r1) — verifies passkey signature
[1] dexter-vault::set_swig — checks the sigverify output, sets state
```

### 4.3 `settle_voucher`

**Purpose:** Adjust the outstanding-tabs counter.

**Signature:**
```rust
pub fn settle_voucher(
    ctx: Context<SettleVoucher>,
    args: SettleVoucherArgs,
) -> Result<()>

pub struct SettleVoucherArgs {
    pub amount: u64,        // currently advisory — not stored
    pub increment: bool,
}
```

**Accounts:**
- `vault` (mut)
- `dexter_session_signer` (signer — must match Dexter's session master key)

**Effects:**
- `increment=true` → `pending_voucher_count = pending_voucher_count.saturating_add(1)`
- `increment=false` → `pending_voucher_count -= 1` (requires `> 0`)

**The `amount` argument is currently advisory.** It is captured for future use (e.g. on-chain ledger of cumulative authorized amount, useful for audit trails) but is not stored in the vault account today. Implementers should expect this field to become load-bearing in v1.1.

### 4.4 `request_withdrawal`

**Purpose:** Record the user's intent to withdraw funds from their bound Swig.

**Signature:**
```rust
pub fn request_withdrawal(
    ctx: Context<RequestWithdrawal>,
    args: RequestWithdrawalArgs,
) -> Result<()>

pub struct RequestWithdrawalArgs {
    pub amount: u64,
    pub destination: Pubkey,
    pub signed_at: i64,
    pub client_data_json: Vec<u8>,
    pub authenticator_data: Vec<u8>,
}
```

**Accounts:**
- `vault` (mut)
- `instructions_sysvar`

**Pre-conditions:**
- `|now - signed_at| <= 300` seconds (drift check)
- Passkey assertion verifies over `b"request_withdrawal" || amount_le || destination_bytes || signed_at_le`

**Effects:**
- Sets `vault.pending_withdrawal = Some(PendingWithdrawal { amount, destination, requested_at: signed_at })`

**Important:** This instruction does **not** move funds. It only records the intent. Funds movement happens after `finalize_withdrawal` succeeds, in a separate Swig transaction.

### 4.5 `finalize_withdrawal`

**Purpose:** Authorize the pending withdrawal — the load-bearing gate.

**Signature:**
```rust
pub fn finalize_withdrawal(
    ctx: Context<FinalizeWithdrawal>,
    args: FinalizeWithdrawalArgs,
) -> Result<()>

pub struct FinalizeWithdrawalArgs {
    pub client_data_json: Vec<u8>,
    pub authenticator_data: Vec<u8>,
}
```

**Accounts:**
- `vault` (mut)
- `swig` (must match `vault.swig_address`)
- `instructions_sysvar`

**Pre-conditions (in order):**
1. `vault.pending_withdrawal` is Some
2. `vault.swig_address != Pubkey::default()`
3. `swig.key() == vault.swig_address`
4. `now - pending.requested_at >= vault.cooling_off_seconds`
5. **`vault.pending_voucher_count == 0`**
6. Passkey assertion verifies over `b"finalize_withdrawal" || pending.amount_le || pending.destination_bytes`

**Effects:**
- Sets `vault.pending_withdrawal = None`.

**Important:** This instruction does **not** move funds either. It clears the pending-withdrawal record after verifying eligibility. The actual transfer must happen in a separate transaction signed by the Swig's root authority (which the buyer's passkey can authorize via the Swig program). The current production flow performs `finalize_withdrawal` and then constructs a Swig sign-and-transfer transaction separately.

---

## 5. Off-chain integration

### 5.1 The facilitator's responsibilities

The Dexter facilitator (Node.js, `dexter-facilitator/src/`) is the primary off-chain consumer of dexter-vault. It:

1. **Operates the session master key.** The facilitator holds a Keypair whose pubkey matches the `dexter_session_signer` expected by `settle_voucher`. This is the key Dexter uses to call `settle_voucher` on behalf of every Tab user.

2. **Looks up vaults by Swig address.** When a session opens, the facilitator queries `dexter-api` for the vault PDA bound to the buyer's Swig (`dexter-facilitator/src/vaultPendingVoucher.ts:84`).

3. **Increments on session-open.** When `/mpp/session/open` is called and the buyer's Swig has a bound vault, the facilitator broadcasts a `settle_voucher(increment=true)` transaction (`mppSession.ts:182`). **Currently fire-and-forget; see issue #45.**

4. **Decrements on session-settle.** When a session closes and settlement broadcasts on-chain, the facilitator appends a `settle_voucher(increment=false)` instruction to the settlement transaction (`mppSession.ts:431`). This atomically pairs the seller-payment with the counter decrement.

5. **Operates fee payers.** All vault transactions are signed by a Dexter-operated fee payer on the relevant Solana network. The buyer pays no SOL.

### 5.2 dexter-api's responsibilities

`dexter-api` (Node.js, `dexter-api/src/`) handles the user-facing flows:

1. **User passkey enrollment.** When a user creates a Tab wallet, dexter-api orchestrates:
   - WebAuthn ceremony in the browser
   - `initialize_vault` call (paid by Dexter)
   - Swig wallet creation (paid by Dexter)
   - `set_swig` call (paid by Dexter, passkey-signed by user)
   - Granting Dexter a session role on the Swig (paid by Dexter, passkey-signed by user)

2. **Vault lookups for the facilitator.** `dexter-api/src/routes/internalPasskeyVault.ts` exposes `/internal/passkey-vault/by-swig/:swigAddress` for the facilitator to query.

3. **Withdrawal orchestration.** When a user wants to withdraw, dexter-api:
   - Constructs the `request_withdrawal` transaction
   - Has the user's passkey sign it via WebAuthn
   - Broadcasts it
   - Waits for cooling-off
   - Constructs the `finalize_withdrawal` transaction
   - Has the user's passkey sign it via WebAuthn
   - Broadcasts it
   - Then constructs the Swig sign-and-transfer transaction
   - Has the user's passkey sign it
   - Broadcasts it

### 5.3 The voucher receipt format

While vault open/close happen on-chain via `settle_voucher`, the actual per-request charges within an open tab are off-chain signed receipts ("vouchers"). The current voucher format (see `dexter-facilitator/src/sessionVoucher.ts`):

```typescript
{
  channel_id: string,        // unique tab identifier
  sequence: number,          // monotonic per-tab
  cumulative_amount: string, // atomic USDC, monotonic
  expires_at: number,        // unix timestamp
  signature: string,         // Ed25519 from facilitator session key
}
```

Sellers verify vouchers locally (no chain call). At tab close, the cumulative amount is settled in a single on-chain transaction.

The voucher format is **not normatively part of OTS v1.0** — facilitators and clients may negotiate their own format. v1.1 may standardize this.

---

## 6. Transaction structures

### 6.1 Vault initialization (Dexter pays)

```
Transaction:
  [0] dexter-vault::initialize_vault
        - vault PDA (init)
        - payer (Dexter fee payer)
        - system_program
        - args: { passkey_pubkey, cooling_off_seconds, supabase_user_id }
  Signers: [Dexter fee payer]
```

### 6.2 set_swig (passkey-signed, Dexter pays)

```
Transaction:
  [0] secp256r1::sigverify
        - sigverify offsets pointing to within this instruction's data
        - data: <pubkey> || <signature> || <message (authData || sha256(clientDataJSON))>
  [1] dexter-vault::set_swig
        - vault (mut)
        - instructions_sysvar
        - args: { swig_address, client_data_json, authenticator_data }
  Signers: [Dexter fee payer]
```

### 6.3 settle_voucher (increment, dedicated tx)

```
Transaction:
  [0] dexter-vault::settle_voucher
        - vault (mut)
        - dexter_session_signer
        - args: { amount, increment: true }
  Signers: [Dexter fee payer, Dexter session master keypair]
```

### 6.4 Session settlement (with embedded decrement)

```
Transaction:
  [0] compute-budget::set_unit_limit (200_000)
  [1] compute-budget::set_unit_price (adaptive priority fee)
  [2..N] Swig::sign instructions (move USDC from buyer to seller)
  [N+1] dexter-vault::settle_voucher
        - args: { amount: cumulative, increment: false }
  Signers: [Dexter fee payer, Dexter session master keypair]
```

The decrement is **embedded** in the settlement transaction so that the counter drops to zero atomically with the seller being paid. If settlement fails, the counter stays at its previous value and the tab remains "open" from the vault's perspective.

### 6.5 Withdrawal (full flow)

Step 1 — request:
```
Transaction A:
  [0] secp256r1::sigverify
  [1] dexter-vault::request_withdrawal
  Signers: [Dexter fee payer]
```

Step 2 — wait `cooling_off_seconds` (default 86,400 = 24h)

Step 3 — finalize + transfer:
```
Transaction B:
  [0] secp256r1::sigverify (passkey assertion for finalize_withdrawal)
  [1] dexter-vault::finalize_withdrawal
        (clears pending_withdrawal — no funds move)
  [2..N] Swig::sign instructions (actual USDC transfer)
  Signers: [Dexter fee payer, plus whatever Swig requires for root authority]
```

In step 3, the actual transfer happens via the Swig program with the buyer's passkey as the signing authority. dexter-vault's role is to *authorize the transfer to be possible* by clearing the pending_withdrawal and confirming the gate was satisfied. The Swig program enforces who can actually move funds.

---

## 7. WebAuthn integration

See `programs/dexter-vault/src/verify/webauthn.rs`.

### 7.1 The signature chain

```
Browser:
  navigator.credentials.get({
    challenge: sha256(operation_message),
    rpId: "dexter.cash",
    ...
  })
  → returns { authenticatorData, clientDataJSON, signature }
                     │              │            │
                     │              │            └── signs (authenticatorData || sha256(clientDataJSON))
                     │              └── JSON: {"type":"webauthn.get","challenge":"<base64url>","origin":"https://dexter.cash"}
                     └── 37+ bytes including rpIdHash + flags + signCount

Off-chain:
  Construct transaction:
    [0] secp256r1::sigverify
          data: <pubkey> <signature> (authenticatorData || sha256(clientDataJSON))
    [1] dexter-vault::xxx
          args: { ..., client_data_json, authenticator_data }

On-chain (in dexter-vault):
  verify_passkey_signed():
    1. Look at previous instruction (must be SIMD-0075)
    2. Confirm SIMD-0075 verified with our stored passkey_pubkey
    3. Confirm SIMD-0075 verified the message (authData || sha256(clientDataJSON))
    4. Parse clientDataJSON, extract challenge field
    5. base64url-decode the challenge
    6. Confirm challenge == sha256(operation_message)
```

### 7.2 Operation messages

Each gated instruction has a distinct operation-message prefix:

| Instruction | Operation message |
|---|---|
| `set_swig` | `b"set_swig" \|\| swig_address[32]` |
| `request_withdrawal` | `b"request_withdrawal" \|\| amount[8 LE] \|\| destination[32] \|\| signed_at[8 LE]` |
| `finalize_withdrawal` | `b"finalize_withdrawal" \|\| amount[8 LE] \|\| destination[32]` |

The challenge in the WebAuthn assertion is `sha256(operation_message)`. The prefix prevents an assertion for one operation from being reused for another.

---

## 8. Build, test, deploy

### 8.1 Build

```bash
cd dexter-vault
anchor build
```

Outputs:
- `target/deploy/dexter_vault.so` — compiled program
- `target/idl/dexter_vault.json` — IDL
- `target/types/dexter_vault.ts` — TypeScript types

### 8.2 Test

```bash
anchor test
```

Runs:
- `tests/initialize-vault.ts`
- `tests/set-swig.ts`
- `tests/settle-voucher.ts`
- `tests/withdrawal-flow.ts`
- `tests/drain-attempt.ts` — **the adversarial test**

### 8.3 Deploy

Currently deployed at `Hg3wRaydFtJhYrdvYrKECacpJYDsC9Px7yKmpncj2fhc` on mainnet. Re-deployment requires the upgrade authority (held by Dexter ops keypair).

For audit-grade redeployment:
1. Build with reproducible toolchain (`rust-toolchain.toml` pinned)
2. `solana program deploy --upgrade-authority <key> target/deploy/dexter_vault.so`
3. Verify deployed bytecode hash matches local build

---

## 9. Implementing OTS — for second/third implementers

If you are implementing OTS in a different repo (e.g. an EVM mirror, an alternative Solana implementation, a different smart-wallet primitive), the required properties are:

### 9.1 Required state

Your vault account MUST contain at minimum:

- A bound passkey or equivalent passwordless authority
- A bound smart-wallet address (one-shot bind)
- A withdrawal-delay configuration
- A counter of outstanding tabs (or equivalent gate)
- A pending-withdrawal record (or equivalent intent)

### 9.2 Required instructions

Your program MUST expose, at minimum:

- An initialization instruction
- A bind-wallet instruction (passkey-gated, one-shot)
- An increment/decrement instruction for outstanding-tabs (facilitator-gated)
- A request-withdrawal instruction (passkey-gated)
- A finalize-withdrawal instruction (passkey-gated, requires `count == 0 AND cooling-off elapsed`)

### 9.3 Required security properties

The implementation MUST enforce:

1. The withdrawal gate (load-bearing).
2. One-shot wallet bind.
3. Passkey signature verification on all passkey-gated instructions.
4. Operation-message uniqueness across instructions (distinct prefixes).
5. Bounded session-role authority on the bound smart-wallet (delegated to the facilitator's spending side).

### 9.4 Recommended but not required

- Adaptive priority fee on settlement transactions
- Atomic decrement-with-settlement (to ensure counter integrity even on partial failures)
- Drift check on signed timestamps
- Replay protection beyond drift (nonces — recommended for v1.1)

### 9.5 Pre-audit checklist

Before going to mainnet:

- [ ] Adversarial test: prove `count > 0` blocks withdrawal
- [ ] Adversarial test: prove one-shot bind cannot be bypassed
- [ ] Adversarial test: prove cross-instruction signature reuse is rejected
- [ ] Document threat model (cf. `SECURITY.md`)
- [ ] External audit

---

## 10. Glossary

| Term | Meaning |
|---|---|
| **Vault** | The dexter-vault account that owns a user's withdrawal-gating state |
| **Swig** | A bounded-authority smart-wallet primitive on Solana (Anagram) |
| **Session role** | A delegated authority on a Swig with `tokenLimit` + TTL — Dexter's spending side |
| **Master key / session master keypair** | The Keypair Dexter operates as `dexter_session_signer` for `settle_voucher` |
| **Passkey** | A secp256r1 / P-256 keypair held in the user's WebAuthn authenticator |
| **WebAuthn / FIDO2** | The browser standard for hardware-backed authentication |
| **secp256r1 sysvar / SIMD-0075** | Solana's on-chain P-256 signature verification precompile |
| **Tab** | An open spending authorization — represented on-chain by `pending_voucher_count > 0` |
| **Voucher** | An off-chain signed receipt for a single charge against an open tab |
| **Cooling-off** | The delay between `request_withdrawal` and the earliest valid `finalize_withdrawal` |
| **Facilitator** | The off-chain service that operates the session-side of the protocol (Dexter or others) |
| **OTS** | Open Tabs Standard — the protocol this program implements |

---

## 11. Refs

- Program ID: `Hg3wRaydFtJhYrdvYrKECacpJYDsC9Px7yKmpncj2fhc` (Solana mainnet)
- Security model: [`SECURITY.md`](./SECURITY.md)
- OTS standards proposal: [`docs/OTS-STANDARDS-PROPOSAL.md`](./docs/OTS-STANDARDS-PROPOSAL.md)
- Technical brief: [`docs/OTS-TECHNICAL-BRIEF.md`](./docs/OTS-TECHNICAL-BRIEF.md)
- Swig smart-wallet: <https://github.com/anagram-xyz/swig>
- WebAuthn spec: <https://www.w3.org/TR/webauthn-2/>
