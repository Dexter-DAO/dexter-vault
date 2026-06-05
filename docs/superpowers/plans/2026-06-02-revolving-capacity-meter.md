# Revolving Capacity Meter (credex metering) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a revolving outstanding-exposure meter to the OTS session so the same encumbered capacity can back tab after tab — turning the shipped "protected payment session" into a revolving-capacity primitive ("credex metering") with measurable turnover > 1, while leaving the existing lock (`pending_voucher_count`) and replay guard (`spent`) untouched.

**Architecture:** The system already has the two on-chain seams the meter needs — they're DISTINCT events (verified by lifecycle trace):
- **Tab-OPEN** → `settle_voucher(increment=true, amount=commitment)` — increments `pending_voucher_count`. **The `amount` is currently discarded** (`let _ = args.amount;` at `settle_voucher.rs:30`). This is where outstanding exposure should RISE.
- **Tab-SETTLE** → `settle_tab_voucher` — advances `spent`, decrements `pending_voucher_count`, **atomic with the USDC transfer** (role-3 Swig ProgramExec). It already computes the settle delta as `_increment = cumulative_amount - spent` and **discards it** (`let _increment = ...` at `settle_tab_voucher.rs:191`). This is where outstanding exposure should FALL.

Both seams already compute the exact amount the meter needs and throw it away. The meter is: stop discarding at open (capture into a new `current_outstanding` field), stop discarding at settle (release the `_increment`), and add an admission cap (`max_revolving_capacity`). `spent` is NOT touched — it stays monotonic for replay defense. The settle-side release is already atomic with the real USDC movement, so the meter can never report freed capacity that didn't actually settle (the safety guard is structural, free).

**Tech Stack:** Anchor (Solana), Rust at `programs/dexter-vault`, TypeScript tests via `anchor test` / ts-mocha, `tests/helpers/secp256r1` for passkey ceremonies.

---

## Background facts (verified firsthand from the lifecycle trace, 2026-06-05)

- **Open and settle are separate on-chain events.** Open = `settle_voucher(increment=true)` driven by facilitator `vaultPendingVoucher.ts:173`. Settle = `settle_tab_voucher` driven by facilitator `tabSettle.ts:329`. The exposure window (open→settle) is real and on-chain.
- **The open amount is discarded:** `settle_voucher.rs:30` is `let _ = args.amount;`. The amount is delivered by the facilitator and ignored. **The meter captures here.**
- **The settle delta is discarded:** `settle_tab_voucher.rs:191` computes `let _increment = cumulative_amount.checked_sub(session.spent)` — the exact USDC moving in this settle — and ignores it. **The meter releases here.**
- **`spent` is monotonic, replay-critical.** Only advances in `settle_tab_voucher` (`active.spent = cumulative_amount`), never decreases. The `cumulative_amount > spent` check is replay defense. **Do not touch `spent`.**
- **Two amount models coexist:** open carries `amount` (a per-tab commitment), settle carries `cumulative_amount` (total-to-date). The meter rises by the open commitment and falls by the per-settle delta (`_increment`). Over a clean tab these net to zero outstanding.
- **Account sizing:** `Vault` uses `#[derive(InitSpace)]`, `space = 8 + Vault::INIT_SPACE`. Adding `u64` fields to `SessionRegistration` grows `INIT_SPACE`. New vaults size correctly; existing mainnet vaults under the old size cannot hold an enlarged `Some(SessionRegistration)`. Task 6 version-gates this (V3).
- **Naming canon (Branch, 2026-06-02):** Vault is the enabling substrate; it enables OTS/tabs and (future) credit. No rename. This adds a capability, not a restructure.
- **`settle_voucher` is NOT legacy** — it is the on-chain tab-OPEN instruction (the open half of open/close). It is load-bearing.

---

## Design: fields, transitions, invariants

Add to `SessionRegistration` (rename `spent`→`cumulative_spent` ONLY for clarity is OPTIONAL and deferred — to minimize churn this plan KEEPS `spent` as-is and adds new fields beside it):

```rust
/// Live unsettled exposure. Rises at tab-open (settle_voucher increment),
/// falls at confirmed settle (settle_tab_voucher). REVOLVES.
pub current_outstanding: u64,
/// Admission cap the revolving meter is checked against. Set at registration,
/// passkey-endorsed. May be <= max_amount.
pub max_revolving_capacity: u64,
```

(`spent` stays exactly as it is — monotonic replay guard + lifetime settled total. We do NOT add a separate `settled_amount`; `spent` already IS the cumulative settled figure, and turnover is computed as `spent / max_revolving_capacity` off-chain.)

State transitions:
- **Tab-open** (`settle_voucher`, `increment=true`, `amount=A`):
  - `pending_voucher_count += 1` (unchanged)
  - if a session is active: admission check `current_outstanding + A <= max_revolving_capacity` → else `RevolvingCapacityExceeded`; then `current_outstanding += A`
- **Tab-open close-marker** (`settle_voucher`, `increment=false`): `pending_voucher_count -= 1` (unchanged). Does NOT touch the meter — meter release happens at `settle_tab_voucher`, the real settle. (This branch is the bare-counter decrement used by non-value paths; leave the meter alone here.)
- **Tab-settle** (`settle_tab_voucher`, settle delta `_increment`):
  - `spent = cumulative_amount` (unchanged)
  - `pending_voucher_count -= 1` (unchanged)
  - if a session is active: `current_outstanding = current_outstanding.saturating_sub(_increment)` (release; saturating so a stranded settle can't underflow)

Invariant:
```
current_outstanding <= max_revolving_capacity      (revolving clearing loop)
```

**Safety guard (structural, free):** the meter releases only inside `settle_tab_voucher`, which is atomic with the USDC transfer (role-3 ProgramExec). Capacity cannot free unless the money actually moved. There is no path that frees capacity on an unsettled voucher.

**Turnover metric (off-chain):** `turnover = spent / max_revolving_capacity`. > 1 means the same capacity backed more than its face value in settled claims = revolving, not drawdown.

---

### Task 1: Add meter fields + errors to state

**Files:**
- Modify: `programs/dexter-vault/src/state.rs`
- Test: `tests/revolving-meter.ts` (create)

- [ ] **Step 1: Write the failing IDL-shape test**

Create `tests/revolving-meter.ts`:

```typescript
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { DexterVault } from "../target/types/dexter_vault";
import { expect } from "chai";

describe("revolving-meter: state shape", () => {
  const program = anchor.workspace.DexterVault as Program<DexterVault>;
  it("SessionRegistration exposes current_outstanding + max_revolving_capacity", () => {
    const idl = program.idl as any;
    const s = idl.types.find((t: any) => t.name === "SessionRegistration");
    const fields = s.type.fields.map((f: any) => f.name);
    expect(fields).to.include("currentOutstanding");
    expect(fields).to.include("maxRevolvingCapacity");
    expect(fields).to.include("spent"); // unchanged, still present
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd /home/branchmanager/websites/dexter-vault && anchor build && yarn run ts-mocha -p ./tsconfig.json tests/revolving-meter.ts -g "state shape"`
Expected: FAIL — new fields absent.

- [ ] **Step 3: Add the two fields to `SessionRegistration` in `state.rs`**

Append inside the struct, after `pub spent: u64,`:

```rust
    /// Live unsettled exposure. Rises at tab-open (settle_voucher increment),
    /// falls at confirmed settle (settle_tab_voucher). This is the field that
    /// REVOLVES — the credex meter.
    pub current_outstanding: u64,
    /// Admission cap the revolving meter is checked against. Set + passkey-
    /// endorsed at register_session_key. May be <= max_amount.
    pub max_revolving_capacity: u64,
```

- [ ] **Step 4: Add error variants to `VaultError` in `state.rs`**

Before the closing brace of `#[error_code] pub enum VaultError`:

```rust
    #[msg("Opening this tab would exceed the session's revolving capacity")]
    RevolvingCapacityExceeded,
    #[msg("max_revolving_capacity must be greater than zero")]
    RevolvingCapacityZero,
```

- [ ] **Step 5: Fix the one constructor in `register_session_key.rs`**

The `SessionRegistration { ... spent: 0 }` literal will not compile. In `register_session_key.rs`, change the construction (currently ending `spent: 0,`) to also set the new fields (Task 2 wires the real cap; for now zero to keep build green):

```rust
                spent: 0,
                current_outstanding: 0,
                max_revolving_capacity: 0, // set properly in Task 2
```

- [ ] **Step 6: Build + run shape test + existing suites**

Run: `anchor build && yarn run ts-mocha -p ./tsconfig.json tests/revolving-meter.ts -g "state shape" tests/register-session-key.ts tests/settle-voucher.ts`
Expected: shape PASS; register-session-key + settle-voucher still PASS (no behavior change yet).

- [ ] **Step 7: Commit**

```bash
git add programs/dexter-vault/src/state.rs programs/dexter-vault/src/instructions/register_session_key.rs tests/revolving-meter.ts
git commit -m "feat(vault): add credex meter fields (current_outstanding, max_revolving_capacity)

Additive beside spent (which stays the monotonic replay guard). Inert until the
open/settle seams drive them (next tasks).

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Set + passkey-endorse `max_revolving_capacity` at registration

**Files:**
- Modify: `programs/dexter-vault/src/instructions/register_session_key.rs`
- Test: `tests/revolving-meter.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/revolving-meter.ts`:

```typescript
describe("revolving-meter: registration", () => {
  const provider = (require("./helpers/secp256r1") as any).makeTestProvider();
  const program = anchor.workspace.DexterVault as Program<DexterVault>;
  it("stores max_revolving_capacity, zeroes current_outstanding", async () => {
    const { vaultPda } = await registerSessionWithCapacity(program, provider, {
      maxAmount: 10_000_000, maxRevolvingCapacity: 2_000_000,
    });
    const s = (await program.account.vault.fetch(vaultPda)).activeSession;
    expect(s.maxRevolvingCapacity.toNumber()).to.equal(2_000_000);
    expect(s.currentOutstanding.toNumber()).to.equal(0);
    expect(s.spent.toNumber()).to.equal(0);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `anchor build && yarn run ts-mocha -p ./tsconfig.json tests/revolving-meter.ts -g "registration"`
Expected: FAIL — arg/helper undefined.

- [ ] **Step 3: Add the arg**

In `register_session_key.rs`, add to `RegisterSessionKeyArgs` after `pub nonce: u32,`:

```rust
    /// Cap the revolving meter (`current_outstanding`) is checked against.
    pub max_revolving_capacity: u64,
```

- [ ] **Step 4: Validate + populate**

After the existing `require!(args.max_amount > 0, VaultError::SessionCapZero);`, add:

```rust
    require!(args.max_revolving_capacity > 0, VaultError::RevolvingCapacityZero);
```

In the `SessionRegistration { ... }` constructor set `max_revolving_capacity: args.max_revolving_capacity,` (replace the `0` placeholder from Task 1; `current_outstanding: 0` stays).

- [ ] **Step 5: Bind the cap into the passkey message**

The registration message is currently 180 bytes and does NOT include the cap, so an operator could register a different cap than the user endorsed. In `build_registration_message`, after `msg.extend_from_slice(&args.nonce.to_le_bytes());` add:

```rust
    msg.extend_from_slice(&args.max_revolving_capacity.to_le_bytes());
```

Change `Vec::with_capacity(180)` → `Vec::with_capacity(188)` and `debug_assert_eq!(msg.len(), 180)` → `debug_assert_eq!(msg.len(), 188)`. Bump the domain literal `REGISTER_DOMAIN` to `b"OTS_SESSION_REGISTER_V2\0\0\0\0\0\0\0\0\0"` (still 32 bytes).

> The test helper `registerSessionWithCapacity` (Task 4) must sign this 188-byte V2 message.

- [ ] **Step 6: Run to verify pass**

Run: `anchor build && yarn run ts-mocha -p ./tsconfig.json tests/revolving-meter.ts -g "registration"`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add programs/dexter-vault/src/instructions/register_session_key.rs tests/revolving-meter.ts
git commit -m "feat(vault): passkey-endorse max_revolving_capacity at registration (188-byte V2 msg)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Capture exposure at the OPEN seam (settle_voucher)

**Files:**
- Modify: `programs/dexter-vault/src/instructions/settle_voucher.rs`
- Test: `tests/revolving-meter.ts`

- [ ] **Step 1: Write the failing tests**

Append to `tests/revolving-meter.ts`:

```typescript
describe("revolving-meter: open captures exposure", () => {
  const provider = (require("./helpers/secp256r1") as any).makeTestProvider();
  const program = anchor.workspace.DexterVault as Program<DexterVault>;

  it("settle_voucher(increment) raises current_outstanding by amount", async () => {
    const { vaultPda } = await registerSessionWithCapacity(program, provider, {
      maxAmount: 10_000_000, maxRevolvingCapacity: 2_000_000,
    });
    await open(program, provider, vaultPda, 1_000_000); // settle_voucher increment, $1
    const s = (await program.account.vault.fetch(vaultPda)).activeSession;
    expect(s.currentOutstanding.toNumber()).to.equal(1_000_000);
  });

  it("rejects an open that exceeds max_revolving_capacity", async () => {
    const { vaultPda } = await registerSessionWithCapacity(program, provider, {
      maxAmount: 10_000_000, maxRevolvingCapacity: 2_000_000,
    });
    await open(program, provider, vaultPda, 2_000_000); // fills capacity
    let threw = false;
    try { await open(program, provider, vaultPda, 1); }
    catch (e: any) { threw = true; expect(e.toString()).to.match(/RevolvingCapacityExceeded/); }
    expect(threw).to.equal(true);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `anchor build && yarn run ts-mocha -p ./tsconfig.json tests/revolving-meter.ts -g "open captures"`
Expected: FAIL — `settle_voucher` discards `amount`.

- [ ] **Step 3: Replace the discard line in `settle_voucher.rs`**

The handler currently ends with `let _ = args.amount;`. Replace the whole `if args.increment { ... } else { ... }` block + the discard with:

```rust
    if args.increment {
        vault.pending_voucher_count = vault.pending_voucher_count.saturating_add(1);
        // Capture exposure: this is the credex meter's RISE seam. The amount
        // the facilitator passes at tab-open was previously discarded
        // (`let _ = args.amount`). Now it raises live outstanding exposure,
        // admission-capped by the session's max_revolving_capacity.
        if let Some(session) = vault.active_session.as_mut() {
            let new_outstanding = session
                .current_outstanding
                .checked_add(args.amount)
                .ok_or(VaultError::RevolvingCapacityExceeded)?;
            require!(
                new_outstanding <= session.max_revolving_capacity,
                VaultError::RevolvingCapacityExceeded
            );
            session.current_outstanding = new_outstanding;
        }
    } else {
        require!(vault.pending_voucher_count > 0, VaultError::NoPendingWithdrawal);
        vault.pending_voucher_count -= 1;
        // No meter change here: the bare-counter decrement is the non-value
        // close marker. Real exposure release happens in settle_tab_voucher
        // (atomic with the USDC transfer).
    }
```

> NOTE: the `if let Some(session)` guard means a `settle_voucher` on a vault with NO active session still moves only the counter — preserving every existing settle-voucher test that doesn't register a session.

- [ ] **Step 4: Run to verify pass**

Run: `anchor build && yarn run ts-mocha -p ./tsconfig.json tests/revolving-meter.ts -g "open captures"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add programs/dexter-vault/src/instructions/settle_voucher.rs tests/revolving-meter.ts
git commit -m "feat(vault): settle_voucher captures exposure at tab-open (credex meter RISE)

Replaces 'let _ = args.amount' — the open commitment now raises
current_outstanding, admission-capped. The amount was always plumbed here;
this connects it.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Test helpers (`open`, `settle`, `registerSessionWithCapacity`)

**Files:**
- Modify: `tests/revolving-meter.ts`
- Reference: `tests/settle-voucher.ts` (provisionVault), `tests/register-session-key.ts` (passkey ceremony), `tests/swig-settle-flow.ts` (how settle_tab_voucher is called in a test)

- [ ] **Step 1: Read the reference flows**

Run: `sed -n '1,200p' tests/register-session-key.ts` and `sed -n '1,200p' tests/swig-settle-flow.ts`
The first shows the secp256r1 registration ceremony (adapt to 188-byte V2). The second shows how `settle_tab_voucher` is invoked in a test (the Ed25519 voucher sibling + Swig accounts) — the `settle` helper mirrors it.

- [ ] **Step 2: Add the `open` helper**

```typescript
async function open(
  program: Program<DexterVault>, provider: anchor.AnchorProvider,
  vaultPda: anchor.web3.PublicKey, amount: number
) {
  await program.methods
    .settleVoucher({ amount: new anchor.BN(amount), increment: true })
    .accountsPartial({ vault: vaultPda, dexterAuthority: provider.wallet.publicKey })
    .rpc();
}
```

- [ ] **Step 3: Add `registerSessionWithCapacity`**

Copy the full provision + passkey ceremony from `tests/register-session-key.ts`, with two deltas: (a) the registration message is 188 bytes — append `maxRevolvingCapacity` u64 LE; (b) domain `OTS_SESSION_REGISTER_V2`. Pass `maxRevolvingCapacity` in the args. Use `provisionVault()` from `settle-voucher.ts` so `dexterAuthority = provider.wallet` (lets `open` sign). Return `{ vaultPda }`. **Mirror the real ceremony — do not stub secp256r1 signing; the on-chain verify rejects fakes.**

- [ ] **Step 4: Add the `settle` helper (real settle_tab_voucher)**

Mirror `tests/swig-settle-flow.ts`'s settle_tab_voucher invocation: build the 44-byte voucher message (channel_id || cumulative_amount LE || sequence LE), Ed25519-sign with the session keypair, prepend the precompile verify ix, supply [swig, swig_wallet] accounts, call `settleTabVoucher`. This is the value-moving close. Return nothing.

> This is adaptation of a working flow (swig-settle-flow.ts). Open that file and mirror it exactly; do not invent a new settle path.

- [ ] **Step 5: Run the full revolving-meter suite green so far**

Run: `anchor build && yarn run ts-mocha -p ./tsconfig.json tests/revolving-meter.ts`
Expected: state-shape, registration, open-captures all PASS (settle-release tests come in Task 5).

- [ ] **Step 6: Commit**

```bash
git add tests/revolving-meter.ts
git commit -m "test(vault): credex meter helpers (open via settle_voucher, settle via settle_tab_voucher)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: Release exposure at the SETTLE seam (settle_tab_voucher)

**Files:**
- Modify: `programs/dexter-vault/src/instructions/settle_tab_voucher.rs`
- Test: `tests/revolving-meter.ts`

- [ ] **Step 1: Write the failing test (open → settle → outstanding revolves to 0)**

Append to `tests/revolving-meter.ts`:

```typescript
describe("revolving-meter: settle releases exposure", () => {
  const provider = (require("./helpers/secp256r1") as any).makeTestProvider();
  const program = anchor.workspace.DexterVault as Program<DexterVault>;

  it("settle_tab_voucher frees current_outstanding by the settle delta", async () => {
    const { vaultPda } = await registerSessionWithCapacity(program, provider, {
      maxAmount: 10_000_000, maxRevolvingCapacity: 2_000_000,
    });
    await open(program, provider, vaultPda, 1_000_000);        // outstanding = 1
    await settle(program, provider, vaultPda, 1_000_000);      // cumulative=1 → delta 1
    const s = (await program.account.vault.fetch(vaultPda)).activeSession;
    expect(s.currentOutstanding.toNumber()).to.equal(0);       // revolved back
    expect(s.spent.toNumber()).to.equal(1_000_000);            // climbs (unchanged semantics)
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `anchor build && yarn run ts-mocha -p ./tsconfig.json tests/revolving-meter.ts -g "settle releases"`
Expected: FAIL — settle doesn't touch the meter; outstanding stays at 1.

- [ ] **Step 3: Release in `settle_tab_voucher.rs`**

The handler computes `let _increment = args.cumulative_amount.checked_sub(session.spent)...` and discards it. Change `let _increment` to `let increment` (drop the underscore so it's used), and in the `if let Some(active) = vault.active_session.as_mut()` block (which currently only sets `active.spent`), add the release:

```rust
    if let Some(active) = vault.active_session.as_mut() {
        active.spent = args.cumulative_amount;
        // Release exposure: the credex meter's FALL seam. `increment` is the
        // USDC actually moving in THIS settle (atomic with the Swig transfer
        // that follows), so capacity frees only against money that really
        // settled. saturating_sub guards a stranded settle (no prior open).
        active.current_outstanding = active.current_outstanding.saturating_sub(increment);
    }
```

> `increment` is computed from the cloned `session.spent` BEFORE this mutation, so it is the correct pre-settle delta.

- [ ] **Step 4: Run to verify pass**

Run: `anchor build && yarn run ts-mocha -p ./tsconfig.json tests/revolving-meter.ts -g "settle releases"`
Expected: PASS.

- [ ] **Step 5: Run the FULL existing suite (no regressions)**

Run: `anchor test`
Expected: all existing tests pass — especially `swig-settle-flow.ts`, `settle-voucher.ts`, `withdrawal-flow.ts`, `drain-attempt.ts`.

- [ ] **Step 6: Commit**

```bash
git add programs/dexter-vault/src/instructions/settle_tab_voucher.rs tests/revolving-meter.ts
git commit -m "feat(vault): settle_tab_voucher releases exposure on confirmed settle (credex meter FALL)

Uses the settle delta (previously 'let _increment') to free current_outstanding,
atomic with the USDC transfer. Capacity revolves. spent untouched.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6: Version-gate the enlarged session (account-size safety)

**Files:**
- Modify: `programs/dexter-vault/src/state.rs`, `initialize_vault.rs`, `register_session_key.rs`, `settle_tab_voucher.rs`, `settle_voucher.rs`
- Test: `tests/revolving-meter.ts`

**Why:** the two new `u64` fields enlarge `Vault::INIT_SPACE`. Existing mainnet v2 vaults can't hold an enlarged `Some(SessionRegistration)`. Gate registration of the enlarged session behind V3; keep accepting v2 for lock-only paths.

- [ ] **Step 1: Write the failing version test**

```typescript
describe("revolving-meter: version", () => {
  const provider = (require("./helpers/secp256r1") as any).makeTestProvider();
  const program = anchor.workspace.DexterVault as Program<DexterVault>;
  it("fresh vault is V3", async () => {
    const { vaultPda } = await registerSessionWithCapacity(program, provider, {
      maxAmount: 10_000_000, maxRevolvingCapacity: 2_000_000,
    });
    expect((await program.account.vault.fetch(vaultPda)).version).to.equal(3);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `anchor build && yarn run ts-mocha -p ./tsconfig.json tests/revolving-meter.ts -g "version"`
Expected: FAIL — version is 2.

- [ ] **Step 3: Add `VAULT_VERSION_V3` and write it at init**

In `state.rs` after `pub const VAULT_VERSION_V2: u8 = 2;`:

```rust
/// v3 adds the credex meter fields (current_outstanding, max_revolving_capacity)
/// to SessionRegistration, enlarging Vault::INIT_SPACE. New vaults init as v3.
pub const VAULT_VERSION_V3: u8 = 3;
```

In `initialize_vault.rs`, change the `vault.version = VAULT_VERSION_V2;` assignment to `VAULT_VERSION_V3`.

- [ ] **Step 4: Gate the version requires**

In `register_session_key.rs`, change `require!(vault.version == VAULT_VERSION_V2, ...)` to `require!(vault.version == VAULT_VERSION_V3, VaultError::UnsupportedVaultVersion);` (registering a revolving session needs v3 space).

In `settle_tab_voucher.rs` and `settle_voucher.rs`, change their `require!(vault.version == VAULT_VERSION_V2, ...)` to accept both:

```rust
    require!(
        vault.version == VAULT_VERSION_V3 || vault.version == VAULT_VERSION_V2,
        VaultError::UnsupportedVaultVersion
    );
```

- [ ] **Step 5: Run version test + full suite**

Run: `anchor build && yarn run ts-mocha -p ./tsconfig.json tests/revolving-meter.ts -g "version" && anchor test`
Expected: version PASS; full suite PASS.

> Migration note (out of scope; track separately): existing mainnet v2 vaults need a one-time realloc + version-bump to register a revolving session. Until then they run lock-only as today. The turnover demo uses fresh v3 vaults, so it's unblocked.

- [ ] **Step 6: Commit**

```bash
git add programs/dexter-vault/src/state.rs programs/dexter-vault/src/instructions/initialize_vault.rs programs/dexter-vault/src/instructions/register_session_key.rs programs/dexter-vault/src/instructions/settle_tab_voucher.rs programs/dexter-vault/src/instructions/settle_voucher.rs tests/revolving-meter.ts
git commit -m "feat(vault): version-gate credex sessions to V3 (account-size safety)

New vaults init V3. v2 vaults keep working lock-only; revolving sessions need V3.
Mainnet v2->v3 realloc tracked separately.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 7: The turnover demo (proves turnover > 1 — the credex proof)

**Files:**
- Create: `tests/turnover-demo.ts`

- [ ] **Step 1: Write the demo**

```typescript
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { DexterVault } from "../target/types/dexter_vault";
import { expect } from "chai";

describe("turnover-demo: credex proof (turnover > 1)", () => {
  const provider = (require("./helpers/secp256r1") as any).makeTestProvider();
  const program = anchor.workspace.DexterVault as Program<DexterVault>;

  it("same $2 capacity clears $10 of settled claims => 5x turnover", async () => {
    const REVOLVING = 2_000_000, CLAIM = 1_000_000, ROUNDS = 10;
    const { vaultPda } = await registerSessionWithCapacity(program, provider, {
      maxAmount: 100_000_000, maxRevolvingCapacity: REVOLVING,
    });
    let cumulative = 0;
    for (let i = 0; i < ROUNDS; i++) {
      await open(program, provider, vaultPda, CLAIM);             // rise
      cumulative += CLAIM;
      await settle(program, provider, vaultPda, cumulative);      // fall (cumulative voucher)
    }
    const s = (await program.account.vault.fetch(vaultPda)).activeSession;
    const turnover = s.spent.toNumber() / s.maxRevolvingCapacity.toNumber();
    console.log(`CREDEX PROOF: settled=$${s.spent.toNumber()/1e6} capacity=$${REVOLVING/1e6} turnover=${turnover}x`);
    expect(s.spent.toNumber()).to.equal(ROUNDS * CLAIM);
    expect(s.currentOutstanding.toNumber()).to.equal(0);
    expect(turnover).to.be.greaterThan(1);
  });
});
```

> Reuse `registerSessionWithCapacity`, `open`, `settle` from `tests/revolving-meter.ts` (extract to `tests/helpers/revolving.ts` and import from both if cleaner — DRY).
> NOTE the cumulative-voucher model: each settle carries the running total, so the settle delta per round = CLAIM, freeing exactly the round's open. Verify `current_outstanding` returns to 0 each round.

- [ ] **Step 2: Run the demo**

Run: `anchor build && yarn run ts-mocha -p ./tsconfig.json tests/turnover-demo.ts`
Expected: PASS, console `CREDEX PROOF: settled=$10 capacity=$2 turnover=5x`.

- [ ] **Step 3: Commit**

```bash
git add tests/turnover-demo.ts tests/helpers/revolving.ts
git commit -m "test(vault): turnover demo — \$2 capacity clears \$10 (5x). credex proof.

Same capacity revolves 10 settled claims. turnover = spent/capacity = 5x > 1.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage** (Branch's intent + the verified seams):
- Capture exposure at open (where `let _ = args.amount` discards it) → Task 3. ✓
- Release exposure at settle (where `let _increment` discards it, atomic w/ transfer) → Task 5. ✓
- Admission cap `max_revolving_capacity`, passkey-endorsed → Tasks 1+2. ✓
- `spent` untouched (monotonic replay guard) → confirmed across all tasks; never decremented. ✓
- Safety guard (release only on confirmed settle) → structural: release lives in settle_tab_voucher, atomic w/ USDC transfer (Task 5). ✓
- Turnover > 1 proof → Task 7 (5x demo). ✓
- Account-size migration risk → Task 6 (V3 gate). ✓
- `settle_voucher` recognized as the OPEN instruction, not legacy → reflected throughout. ✓

**Placeholder scan:** Task 4 Steps 3–4 (passkey ceremony + settle_tab_voucher helpers) are adaptation-of-existing-working-flows (`register-session-key.ts`, `swig-settle-flow.ts`), flagged explicitly with exact deltas — justified because the ceremonies are long and must not be reinvented. All program-code steps show complete code.

**Type consistency:** `current_outstanding`/`currentOutstanding`, `max_revolving_capacity`/`maxRevolvingCapacity`, `spent`/`spent` consistent Rust-snake/TS-camel. Errors `RevolvingCapacityExceeded`, `RevolvingCapacityZero` defined Task 1, used Tasks 2/3. `VAULT_VERSION_V3` defined Task 6, gated in register/settle_tab/settle. The release uses `increment` (un-underscored) computed pre-mutation in Task 5.

**Out-of-scope / tracked follow-ups:**
- Mainnet v2→v3 realloc instruction (Task 6 note).
- Facilitator: confirm `vaultPendingVoucher.ts` passes a meaningful commitment `amount` at open (today it may pass `deposit_atomic`; the meter now uses it). And confirm `tabSettle.ts` settle path is unaffected. dexter-facilitator change, tracked there.
- Whether the open commitment `amount` and the cumulative settle model net cleanly across partial settles / multi-voucher tabs — the demo covers the clean 1-open-1-settle-per-round case; multi-voucher-per-open needs its own test if that flow exists.
