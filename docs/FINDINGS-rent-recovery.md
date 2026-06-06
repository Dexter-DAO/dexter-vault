# FINDINGS — test-vault rent backlog & the recovery gap (2026-06-06)

**Status:** documented + PARKED. This is a known, costed backlog item — NOT a master-plan
task. The recovery requires a program upgrade; fold it into the next program upgrade we do
for a real reason. Do NOT spin a dedicated upgrade just to reclaim this.

All figures in **SOL** (live mainnet rent-exempt minimums, queried 2026-06-06).
SOL price intentionally omitted — these are protocol rent constants, not market estimates.

---

## The backlog (measured live on mainnet)

- **435 vault PDAs** owned by the dexter-vault program (`Hg3wRaydFtJhYrdvYrKECacpJYDsC9Px7yKmpncj2fhc`).
  - Total parked: **1.258542000 SOL** (exact, summed across all 435).
  - Mean per vault PDA: **0.002893200 SOL** (varies by version V2/V3/V4 account size).
- **Program-data account** (`B8JA9f4dgtHAAGdAxFkT4CP2cxVzBTWA1GEj8FJjFtmy`): **3.058592880 SOL**.
  - This is the program binary's rent. Loader-owned, **NOT reclaimable** (would require
    shrinking the program). Excluded from the backlog. Branch already said: forget it.

**So the reclaimable vault-PDA backlog is ~1.2585 SOL**, authority'd to a key Branch holds
(every test vault was created with `dexterAuthority: provider.wallet.publicKey`, i.e. the
upgrade-authority/main wallet `X4o2kSLzqEQjnAzhq3L3BW92aawMV2n2F37EXd2GMpy`).

---

## Why it's not recoverable TODAY (the gap)

The deployed program exposes **19 instructions and NONE of them close a vault or sweep its
rent.** A PDA owned by dexter-vault can only have its lamports swept by an instruction *inside*
dexter-vault. That instruction does not exist. Therefore the 1.2585 SOL is **stranded behind a
program upgrade**, not lost.

| Account type | Owner / authority | Recoverable today? | Path |
|---|---|---|---|
| Vault PDAs (×435) | authority = main wallet | ❌ no | needs `close_vault` instruction + upgrade |
| Swig-owned ATAs | swig-wallet PDA | ❌ no (not under main wallet) | needs swig's account-close path (uninvestigated) |
| Test mints | mint authority = provider wallet | ✅ likely | standard SPL close (low value) |
| Main-wallet ATAs | main wallet | ✅ yes | only **1** exists (0.002039280 SOL) — negligible |

**Genuinely lost (unrecoverable):** almost nothing. The test harness uses
`Keypair.generate().publicKey` for `sellerOwner` / `allowedCounterparty` (throwaway *destination*
addresses) — but nothing is created under those keys, so they hold no rent. The session keys are
ephemeral but hold no rent. The vault authority is the main wallet, which Branch controls. So the
backlog is **parked-behind-upgrade, not lost.**

---

## Per-run cost of one full meter-test provisioning (SOL)

What one `registerSettleableVault` run stands up:

| Account | Size | Rent (SOL) | Reclaimable |
|---|---|---|---|
| Vault PDA (V4) | 341 B | 0.003264240 | parked (needs close_vault) |
| Swig account | ~varies | ~0.001400000 | parked (needs swig close) |
| Test mint | 82 B | 0.001461600 | SPL-closeable |
| Source ATA | 165 B | 0.002039280 | parked (swig-owned) |
| Seller ATA | 165 B | 0.002039280 | parked (swig-owned) |
| **Rent subtotal** | | **~0.010204400 SOL** | mostly parked |
| Tx fees (~25 sigs × 0.000005) | | **0.000125000 SOL** | **burned (gone)** |
| **Total / run** | | **~0.010329400 SOL** | |

**Truly burned per run: 0.000125000 SOL** (transaction fees only — unrecoverable).
**Parked per run: ~0.010204400 SOL** (rent, recoverable once close paths exist).

---

## The fix (when we do it — gated, folded into a real upgrade)

A guarded **`close_vault`** instruction:
- **Close-only-if-empty:** assert zero balance, zero `current_outstanding`, zero
  `outstanding_locked_amount`, zero `pending_voucher_count` before sweeping. Same rigor as the
  anti-rug guards — must never strand a financier's claim or a user's funds.
- **Version-agnostic:** works across V2/V3/V4 (close only needs the balance/outstanding fields,
  not the interior layout) so ONE upgrade reclaims the whole 435-vault backlog AND every future run.
- Sweeps rent to the vault authority (the main wallet).
- Plus: investigate swig's account-close interface to recover the swig-owned ATAs.

**This is a superpowers plan+execute job (safety-critical instruction + gated mainnet upgrade),
not a cowboy edit. Queue it; ride it on the next upgrade. Net recoverable: ~1.2585 SOL + the
swig-owned ATA rent, and the per-run bleed drops to just the 0.000125 SOL of burned fees.**
