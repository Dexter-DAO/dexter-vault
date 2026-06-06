# Combined Phase 1 Deploy Checklist

**One atomic deploy window. Branch executes. Everything below is staged build-only and reviewed; nothing is deployed/published until Branch runs this.**

Date staged: 2026-06-06. Author: credex/vault Claude (session continues from `e0a2c1c7`).

---

## WHY THIS IS ONE COMBINED DEPLOY (not three)

Three bodies of work are mutually dependent and MUST flip together, or the system is internally inconsistent mid-flight:

1. **The migration** (`migrate_v3_to_v4`) — credex's half. Reallocs V3 vaults to V4. Without it, the typed `finalize_withdrawal` reservation check (below) freezes every un-migrated vault on load.
2. **The LockedClaim instructions** (4 new + 2 modified handlers + new account + 5 errors) — the other agent's half. These ADD the V4 struct fields' consumers and the reservation/overcommit checks.
3. **The SDK 0.4.2 republish** — credex's half. The Phase 1 work changed the ON-CHAIN account lists of `register_session_key` (2→5 accounts) and `finalize_withdrawal` (4→5). The published `@dexterai/vault@0.4.1` builders emit the OLD lists → every client's register/finalize breaks the instant the program upgrades. 0.4.2 fixes the builders. It MUST publish in the same window as the program upgrade so client and program never disagree.

**The coupling, stated plainly:**
- Deploy program WITHOUT 0.4.2 SDK → clients calling register/finalize break (wrong account list).
- Publish 0.4.2 SDK WITHOUT deploying program → clients break against the still-old deployed program (which wants the old lists).
- Deploy LockedClaim WITHOUT the migration → existing V3 vaults freeze on the typed reservation read.

So: **program upgrade + SDK publish happen together; the migration is part of the program upgrade (same .so).**

---

## PRE-DEPLOY STATE (all staged, all local/unpushed)

### dexter-vault (the program) — `main`, unpushed
- Migration half (credex): `migrate_v3_to_v4` + V4 struct fields + version gates. Commits a6ae417..ab9a18f.
- LockedClaim half (other agent): 4 new instructions, 2 modified (`settle_tab_voucher` frontier guard, `register_session_key`/`finalize_withdrawal` reservation gates), `LockedClaim` account, 5 new errors. Commits d15e27a..c4d9fe5.
- **Built .so:** byte hash `2920d27cd1ed30ea77e661ca57ec20f4fbb37452f789a543afb39b32203d9cd5`, 432,120 bytes, **19 instructions, 20 errors** (verify these match at deploy time — rebuild and re-hash).
- Seam review: credex reviewed all 4 seam-touching commits (lock_voucher graduation, settle_tab frontier, finalize reservation, register overcommit) — APPROVED, zero open questions (the active_session Some-asymmetry is guarded by the `NoActiveSession` require at lock_voucher.rs:159).

### dexter-vault-sdk (`@dexterai/vault`) — `main`, unpushed
- 0.4.2 staged: register builder (5 accounts), finalize builder (5 accounts). Commits 998d7b5, 3502f5b, cb25bcb.
- DATA byte-unchanged (only account keys grew). 81/81 tests green. Registry still at 0.4.1.

### dexter-facilitator — `main`, unpushed
- Pin already at `^0.4.1` (will need bump to `^0.4.2` post-publish — see step 7).

---

## THE DEPLOY SEQUENCE (Branch executes, in order)

> Discipline: use the Helius RPC (`HELIUS_RPC_URL` from `dexter-vault/.env` once created, or inline `https://mainnet.helius-rpc.com/?api-key=<key>`), never mainnet-beta. PATH needs `~/.local/share/solana/install/active_release/bin`. Wallet: `~/.config/solana/dexter-vault/upgrade-authority.json` (~2.25 SOL).

- [ ] **1. Final rebuild + hash check.** `cd dexter-vault && anchor build`. Confirm the .so byte hash and instruction count (19) match the staged values above. If they differ, STOP — something changed since staging; re-review.

- [ ] **2. Pre-deploy SOL check.** Upgrade-authority wallet needs enough for the program upgrade (~2.3+ SOL for a 432KB .so realloc). Current ~2.25 SOL — **may need a top-up before deploy.** Check `solana balance` and top up if under ~2.5 SOL.

- [ ] **3. Deploy the program upgrade (THE gate — Branch's explicit go).**
  ```bash
  cd dexter-vault && anchor upgrade target/deploy/dexter_vault.so \
    --program-id Hg3wRaydFtJhYrdvYrKECacpJYDsC9Px7yKmpncj2fhc \
    --provider.cluster <helius-url>
  ```
  Record the upgrade tx signature. Verify the deployed program now exposes 19 instructions (fetch IDL or simulate a new instruction).

- [ ] **4. Publish @dexterai/vault 0.4.2 (immediately after, same window).**
  ```bash
  cd dexter-vault-sdk && npm publish
  ```
  Poll until `npm view @dexterai/vault@0.4.2 version` returns 0.4.2. This closes the client/program account-list gap.

- [ ] **5. Migrate the V3 vaults (Branch authorizes the specific addresses).**
  8 V3 vaults exist (6 Some, 2 None), 7 under the upgrade-authority wallet. Run the migration proof + migrate the real vaults:
  ```bash
  cd dexter-vault && RUN_MIGRATION_PROOF=1 \
    ANCHOR_WALLET=~/.config/solana/dexter-vault/upgrade-authority.json \
    ANCHOR_PROVIDER_URL=<helius-url> \
    npx ts-mocha -p ./tsconfig.json -t 600000 tests/migrate-v3-to-v4.ts
  ```
  This migrates the default Some + None vaults and asserts bit-for-bit field preservation + 5 new fields = 0. **The migration is irreversible** (reallocs to 341 bytes) — confirm the target vault addresses are the throwaway-controllable ones (defaults) or override via `MIGRATE_V3_SOME_VAULT`/`MIGRATE_V3_NONE_VAULT`.

- [ ] **6. Collective post-deploy test run (the proof the whole thing works).**
  Against the upgraded program + published 0.4.2 SDK, run the full Phase 1 mainnet suite:
  ```bash
  # All on Helius, sandbox-disabled for fetch:
  npx ts-mocha -p ./tsconfig.json -t 600000 tests/lock-voucher.ts
  npx ts-mocha -p ./tsconfig.json -t 600000 tests/xor-tab-then-lock.ts
  npx ts-mocha -p ./tsconfig.json -t 600000 tests/transfer-lock-ownership.ts
  npx ts-mocha -p ./tsconfig.json -t 600000 tests/locked-claim-settle.ts
  npx ts-mocha -p ./tsconfig.json -t 600000 tests/recover-abandoned-lock.ts
  npx ts-mocha -p ./tsconfig.json -t 600000 tests/finalize-withdrawal-reservation.ts
  npx ts-mocha -p ./tsconfig.json -t 600000 tests/register-session-overcommit.ts
  npm run prove:credex   # the 5x meter proof still passes (regression)
  ```
  **The two XOR tests are the load-bearing proof** (lock-then-settle rejected; settle-then-lock rejected) — they prove the crystallized tier's double-spend guard works on-chain. Plus unskip the SDK-path register test in `register-session-key.ts` (now that 0.4.2 is published with the new accounts).

- [ ] **7. Bump consumers to 0.4.2.**
  - `dexter-facilitator`: `npm pkg set dependencies.@dexterai/vault="^0.4.2" && npm install`
  - `dexter-x402-sdk`: same, if it builds register/finalize (it builds register — yes, bump it).
  - Re-run their tests/typecheck to confirm.

- [ ] **8. Push (Branch's call).** All the Phase 1 commits across dexter-vault / dexter-vault-sdk / dexter-facilitator are local/unpushed. Push when ready.

---

## ROLLBACK NOTE
The program upgrade is the only hard-to-reverse step. If the post-deploy suite (step 6) reveals a real bug, the upgrade-authority can deploy a fixed .so (another upgrade) — the program is upgradeable. The migration (step 5) is per-vault irreversible (realloc), so do step 6's NON-migration tests can't fully run pre-migration, but the migration proof itself (step 5) is the gate: if it fails bit-for-bit assertion on the first vault, STOP before migrating more.

## WHAT'S ALREADY PROVEN (so the deploy is lower-risk than it looks)
- The meter (V3) is live + 5x proven. The migration decode/re-encode was reviewed field-by-field. The LockedClaim seam was reviewed (4 commits, approved). The SDK 0.4.2 account lists match the IDL exactly (byte-parity green). The only thing that CAN'T be proven pre-deploy is the on-chain behavior of the not-yet-deployed instructions — which is exactly what step 6 proves, and why it's the gate.
