/**
 * migrate-fleet.ts — walk every pre-V6 Vault account on the dexter-vault
 * program up the migration chain to V6 (V2 → V3 → V4 → V5 → V6).
 *
 *   npx tsx scripts/migrate-fleet.ts                       # dry-run (DEFAULT, read-only)
 *   npx tsx scripts/migrate-fleet.ts --dry-run \
 *       --authority-keypair ~/keys/auth1.json \
 *       --payer-keypair ~/keys/payer.json                  # dry-run + key coverage report
 *   FLEET_MIGRATE_I_UNDERSTAND=yes npx tsx scripts/migrate-fleet.ts --execute \
 *       --authority-keypair ~/keys/auth1.json \
 *       --payer-keypair ~/keys/payer.json [--limit 5] [--vault <pubkey>]
 *   npx tsx scripts/migrate-fleet.ts --verify-only         # census re-read, no sends
 *
 * ── Migration-hop inventory (from programs/dexter-vault/src/instructions/) ──
 *
 *  hop                    accounts (exact order)                              signers                size       rent flow
 *  migrate_v2_to_v3       vault(w), dexter_authority(s), payer(s,w), system   authority + payer      289 → 305  payer tops up (+16 B)
 *  migrate_v3_to_v4       vault(w), dexter_authority(s), payer(s,w), system   authority + payer      305 → 341  payer tops up (+36 B)
 *  migrate_v4_to_v5       vault(w), dexter_authority(s), payer(s,w), system   authority + payer      341 → 399  payer tops up (+58 B)
 *  migrate_v5_to_v6       vault(w), dexter_authority(s), payer(s,w), system   authority + payer      399 → 279  payer REFUNDED (−120 B)
 *  migrate_v5_to_v6_with_session
 *                         vault(w), dexter_authority(s), session(w),          authority + payer      399 → 279  payer funds session PDA
 *                         payer(s,w), system   args: live_counterparty(32)                            +162-B SessionAccount,
 *                                                                                                     receives vault shrink refund
 *
 *  Every hop is gated by the vault's RECORDED dexter_authority (must sign).
 *  The payer is a separate signer that funds growth rent / receives shrink rent.
 *  All hops take the vault as a raw AccountInfo (no Anchor auto-deserialize),
 *  verify discriminator == Vault and version byte == the expected FROM version,
 *  so a re-sent landed hop reverts with UnsupportedVaultVersion — we self-heal
 *  by re-reading the chain (chain state is truth) before any retry.
 *
 *  The plain migrate_v5_to_v6 REJECTS a vault carrying a LIVE (unexpired)
 *  active_session (SessionAlreadyActive); such vaults must use the
 *  with_session variant, which carries the session out into a SessionAccount
 *  PDA at seeds [b"session", vault, allowed_counterparty]. An EXPIRED session
 *  is dropped by the plain path. This script decodes the V5 active_session at
 *  hop time and picks the right instruction.
 *
 * ── dexter_authority offset derivation (per-generation) ─────────────────────
 *
 *  Ground truth: programs/dexter-vault/src/state.rs and the frozen reader
 *  structs in migrate_v3_to_v4.rs / migrate_v4_to_v5.rs / migrate_v5_to_v6.rs.
 *  Every generation V2..V6 shares an IDENTICAL Borsh prefix up to and including
 *  dexter_authority — each version only ever appended/changed fields AFTER it
 *  (V3: session tail growth; V4: session interior + vault tail; V5: vault tail;
 *  V6: active_session Option → live_session_count u8). So ONE prefix walk reads
 *  the authority for ALL generations. The only variable-length prefix field is
 *  pending_withdrawal: Option<PendingWithdrawal> (1 B if None, 1+48 B if Some):
 *
 *    offset  field                       size
 *    0       Anchor discriminator        8     (sha256("account:Vault")[0..8] = d308e82b02987577)
 *    8       version: u8                 1
 *    9       bump: u8                    1
 *    10      passkey_pubkey: [u8;33]     33
 *    43      swig_address: Pubkey        32
 *    75      cooling_off_seconds: u32    4
 *    79      pending_voucher_count: u32  4
 *    83      pending_withdrawal tag      1     (+48 body iff tag == 1: amount u64, destination Pubkey, requested_at i64)
 *    84|132  identity_claim: [u8;32]     32
 *    116|164 dexter_authority: Pubkey    32    ← read here
 *    148|196 active_session tag (v2..v5) 1     (V6: live_session_count u8)
 *
 *  Within a Some active_session, the first 6 fields are identical across
 *  V2/V3/V4/V5 session layouts (session_pubkey 32, max_amount 8, expires_at 8,
 *  allowed_counterparty 32, nonce 4, spent 8 — V3/V4 only APPENDED), so
 *  expires_at  = sessionStart+40 and allowed_counterparty = sessionStart+48
 *  hold for every generation.
 *
 * ── Account sizes (8-byte discriminator + INIT_SPACE, fixed per generation) ──
 *    V2 = 289   V3 = 305   V4 = 341   V5 = 399   V6 = 279   SessionAccount = 162
 *
 * ── Exclusions (logged, NEVER walked) ────────────────────────────────────────
 *  - any 279-byte vault that is not version 6 ("born-broken": V6 layout stamped
 *    version 4 — handled by a SEPARATE program release, not this walk)
 *  - version/size mismatches (e.g. v2@305, v4@399) — layout state unproven;
 *    walking them risks stale-tail corruption (the grow-hops only zero-fill
 *    GROWN bytes; an already-grown account would keep stale tail bytes)
 *  - oddballs (151/183 B, byte@8 in 251..254) — not any known Vault layout
 *  - non-Vault discriminators (SessionAccount / LockedClaim / StandbyBacker)
 *
 * Safety: --dry-run (default) and --verify-only NEVER construct a Transaction
 * and never need a keypair. --execute additionally requires
 * FLEET_MIGRATE_I_UNDERSTAND=yes. Journal: scripts/.fleet-migration-journal.jsonl
 * (append-only JSONL, gitignored) — for audit/resume speed; chain is truth.
 */

import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";

// ── Constants ────────────────────────────────────────────────────────────────

const PROGRAM_ID = new PublicKey(
  "Hg3wRaydFtJhYrdvYrKECacpJYDsC9Px7yKmpncj2fhc"
);

// NEVER api.mainnet-beta — Helius only.
const RPC_URL =
  process.env.RPC_URL ??
  "https://mainnet.helius-rpc.com/?api-key=8fd1a2cd-76e7-4462-b38b-1026960edd40";

// Anchor instruction discriminators: sha256("global:<name>")[0..8].
// Cross-checked against dexter-vault-sdk src/constants/index.ts DISCRIMINATORS
// (migrate_v4_to_v5 / migrate_v5_to_v6 / with_session match byte-for-byte).
const IX_DISC: Record<string, Buffer> = {
  migrate_v2_to_v3: Buffer.from([25, 157, 17, 205, 179, 34, 196, 207]),
  migrate_v3_to_v4: Buffer.from([28, 136, 16, 88, 66, 176, 223, 54]),
  migrate_v4_to_v5: Buffer.from([226, 105, 140, 184, 101, 39, 235, 116]),
  migrate_v5_to_v6: Buffer.from([25, 38, 151, 206, 59, 103, 141, 175]),
  migrate_v5_to_v6_with_session: Buffer.from([
    225, 119, 165, 163, 251, 174, 42, 15,
  ]),
};

// Anchor account discriminators: sha256("account:<Name>")[0..8].
const VAULT_DISC_HEX = "d308e82b02987577";
const ACCOUNT_DISC_NAMES: Record<string, string> = {
  [VAULT_DISC_HEX]: "Vault",
  "4a22418560a35045": "SessionAccount",
  "92e3fecd095206f5": "LockedClaim",
  "5bd14e01e43998e8": "StandbyBacker",
};

const SESSION_SEED = Buffer.from("session");

// size = 8 + INIT_SPACE, fixed per generation (accounts are allocated at the
// Option-max INIT_SPACE; mainnet ground truth confirms every clean cohort).
const GEN_SIZE: Record<number, number> = {
  2: 289,
  3: 305,
  4: 341,
  5: 399,
  6: 279,
};
const SESSION_ACCOUNT_SIZE = 162; // 8 + (1 + 1 + 32 + 120)
const V6_SIZE = 279;

const LAMPORTS_PER_SIG = 5000;
const JOURNAL_PATH = path.join(__dirname, ".fleet-migration-journal.jsonl");

const RPC_MAX_RPS = Number(process.env.RPC_MAX_RPS ?? "6");

// ── CLI ──────────────────────────────────────────────────────────────────────

interface Cli {
  mode: "dry-run" | "execute" | "verify-only";
  authorityKeypairPaths: string[];
  payerKeypairPath?: string;
  limit?: number;
  onlyVaults: Set<string>;
}

function parseCli(argv: string[]): Cli {
  const cli: Cli = {
    mode: "dry-run",
    authorityKeypairPaths: [],
    onlyVaults: new Set(),
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--dry-run":
        cli.mode = "dry-run";
        break;
      case "--execute":
        cli.mode = "execute";
        break;
      case "--verify-only":
        cli.mode = "verify-only";
        break;
      case "--authority-keypair":
        cli.authorityKeypairPaths.push(argv[++i]);
        break;
      case "--payer-keypair":
        cli.payerKeypairPath = argv[++i];
        break;
      case "--limit":
        cli.limit = Number(argv[++i]);
        break;
      case "--vault":
        cli.onlyVaults.add(argv[++i]);
        break;
      default:
        throw new Error(`unknown flag: ${a}`);
    }
  }
  return cli;
}

function loadKeypair(p: string): Keypair {
  const raw = JSON.parse(
    fs.readFileSync(p.replace(/^~/, process.env.HOME ?? "~"), "utf8")
  );
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

// ── Rate-limited RPC (token bucket + 429 backoff; NO websockets anywhere) ────

let nextSlotAt = 0;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function pace(): Promise<void> {
  const interval = 1000 / RPC_MAX_RPS;
  const now = Date.now();
  const at = Math.max(now, nextSlotAt);
  nextSlotAt = at + interval;
  if (at > now) await sleep(at - now);
}

async function rpc<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    await pace();
    try {
      return await fn();
    } catch (err: any) {
      const msg = String(err?.message ?? err);
      const is429 = msg.includes("429") || msg.includes("Too Many Requests");
      if (is429 && attempt < 6) {
        await sleep(Math.min(300 * 2 ** attempt, 5000));
        continue;
      }
      throw err;
    }
  }
}

// disableRetryOnRateLimit: web3.js's internal fixed-500ms 429 retry would
// swallow 429s before our limiter's backoff sees them (same rationale as
// tests/helpers/secp256r1.ts makeTestProvider).
const connection = new Connection(RPC_URL, {
  commitment: "confirmed",
  disableRetryOnRateLimit: true,
});

// ── Layout readers (see offset table in the header) ─────────────────────────

interface Prefix {
  version: number;
  pendingWithdrawalSome: boolean;
  authority: PublicKey;
  authorityOffset: number;
  afterAuthority: number; // offset of active_session tag (v2..v5) / live_session_count (v6)
}

function readPrefix(data: Buffer): Prefix {
  let o = 8; // skip discriminator
  const version = data[o];
  o += 1; // version
  o += 1; // bump
  o += 33; // passkey_pubkey
  o += 32; // swig_address
  o += 4; // cooling_off_seconds
  o += 4; // pending_voucher_count
  const pwTag = data[o];
  if (pwTag !== 0 && pwTag !== 1)
    throw new Error(`bad pending_withdrawal tag ${pwTag}`);
  const pendingWithdrawalSome = pwTag === 1;
  o += 1 + (pendingWithdrawalSome ? 48 : 0); // PendingWithdrawal = u64 + Pubkey + i64
  o += 32; // identity_claim
  const authorityOffset = o;
  const authority = new PublicKey(data.subarray(o, o + 32));
  o += 32;
  return {
    version,
    pendingWithdrawalSome,
    authority,
    authorityOffset,
    afterAuthority: o,
  };
}

interface SessionInfo {
  some: boolean;
  expiresAt?: bigint;
  counterparty?: PublicKey;
}

// Valid for v2..v5 (first 6 session fields are layout-identical; see header).
function readActiveSession(data: Buffer, afterAuthority: number): SessionInfo {
  const tag = data[afterAuthority];
  if (tag !== 1) return { some: false };
  const s = afterAuthority + 1;
  return {
    some: true,
    expiresAt: data.readBigInt64LE(s + 40),
    counterparty: new PublicKey(data.subarray(s + 48, s + 80)),
  };
}

// ── Census ───────────────────────────────────────────────────────────────────

type Cls =
  | "v2"
  | "v3"
  | "v4"
  | "v5"
  | "v6"
  | "born-broken-279"
  | "mismatch"
  | "oddball"
  | "non-vault";

interface Rec {
  pubkey: PublicKey;
  size: number;
  lamports: number;
  versionByte: number;
  cls: Cls;
  clsDetail: string;
  walkable: boolean;
  authority?: PublicKey;
  session?: SessionInfo;
  data: Buffer;
}

function classify(pubkey: PublicKey, data: Buffer, lamports: number): Rec {
  const size = data.length;
  const discHex = data.subarray(0, 8).toString("hex");
  const versionByte = data[8] ?? -1;
  const base = { pubkey, size, lamports, versionByte, data };

  if (discHex !== VAULT_DISC_HEX) {
    const name = ACCOUNT_DISC_NAMES[discHex] ?? `unknown-disc:${discHex}`;
    return { ...base, cls: "non-vault", clsDetail: name, walkable: false };
  }

  // EXCLUDE anything 279 B that isn't a finished V6 — the born-broken cohort
  // (V6-layout bytes stamped version 4) is handled by a SEPARATE program
  // release, never by this walk.
  if (size === V6_SIZE) {
    if (versionByte === 6) {
      const p = readPrefix(data);
      return {
        ...base,
        cls: "v6",
        clsDetail: "v6@279 (done)",
        walkable: false,
        authority: p.authority,
      };
    }
    return {
      ...base,
      cls: "born-broken-279",
      clsDetail: `279 B stamped version ${versionByte} — EXCLUDED (separate release)`,
      walkable: false,
    };
  }

  if (versionByte >= 2 && versionByte <= 5) {
    const expected = GEN_SIZE[versionByte];
    if (size === expected) {
      const p = readPrefix(data);
      const session = readActiveSession(data, p.afterAuthority);
      return {
        ...base,
        cls: `v${versionByte}` as Cls,
        clsDetail: `v${versionByte}@${size}`,
        walkable: true,
        authority: p.authority,
        session,
      };
    }
    return {
      ...base,
      cls: "mismatch",
      clsDetail: `version ${versionByte} but ${size} B (expected ${expected}) — EXCLUDED`,
      walkable: false,
    };
  }

  return {
    ...base,
    cls: "oddball",
    clsDetail: `${size} B, byte@8=${versionByte} — EXCLUDED`,
    walkable: false,
  };
}

async function census(): Promise<Rec[]> {
  const accounts = await rpc(() =>
    connection.getProgramAccounts(PROGRAM_ID, { commitment: "confirmed" })
  );
  return accounts.map(({ pubkey, account }) =>
    classify(pubkey, account.data as Buffer, account.lamports)
  );
}

// ── Instruction builders (account orders verified against the Rust source) ──

function migrateIx(
  name:
    | "migrate_v2_to_v3"
    | "migrate_v3_to_v4"
    | "migrate_v4_to_v5"
    | "migrate_v5_to_v6",
  vault: PublicKey,
  authority: PublicKey,
  payer: PublicKey
): TransactionInstruction {
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: vault, isSigner: false, isWritable: true },
      { pubkey: authority, isSigner: true, isWritable: false },
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: IX_DISC[name], // empty args struct → discriminator only
  });
}

function migrateV5ToV6WithSessionIx(
  vault: PublicKey,
  authority: PublicKey,
  payer: PublicKey,
  liveCounterparty: PublicKey
): TransactionInstruction {
  const [sessionPda] = PublicKey.findProgramAddressSync(
    [SESSION_SEED, vault.toBuffer(), liveCounterparty.toBuffer()],
    PROGRAM_ID
  );
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: vault, isSigner: false, isWritable: true },
      { pubkey: authority, isSigner: true, isWritable: false },
      { pubkey: sessionPda, isSigner: false, isWritable: true },
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([
      IX_DISC.migrate_v5_to_v6_with_session,
      liveCounterparty.toBuffer(),
    ]),
  });
}

// ── Journal ──────────────────────────────────────────────────────────────────

interface JournalEntry {
  ts: string;
  vault: string;
  hop: string;
  fromVersion: number;
  toVersion: number;
  sig?: string;
  status: "confirmed" | "self-healed" | "failed" | "verified";
  error?: string;
}

function journalAppend(e: JournalEntry): void {
  fs.appendFileSync(JOURNAL_PATH, JSON.stringify(e) + "\n");
}

function journalLoad(): JournalEntry[] {
  if (!fs.existsSync(JOURNAL_PATH)) return [];
  return fs
    .readFileSync(JOURNAL_PATH, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

// ── HTTP-poll send/confirm (NO websocket; pattern: tests/helpers/secp256r1.ts) ─

function isTransient(msg: string): boolean {
  return (
    msg.includes("TransactionExpiredTimeoutError") ||
    msg.includes("was not confirmed") ||
    msg.includes("block height exceeded") ||
    msg.includes("Blockhash not found") ||
    msg.includes("expired") ||
    msg.includes("429") ||
    msg.includes("Too Many Requests")
  );
}

async function sendAndConfirmHttp(
  ix: TransactionInstruction,
  payer: Keypair,
  extraSigners: Keypair[],
  timeoutMs = 90_000,
  pollIntervalMs = 2_000
): Promise<string> {
  const { blockhash } = await rpc(() =>
    connection.getLatestBlockhash("confirmed")
  );
  const tx = new Transaction();
  tx.feePayer = payer.publicKey;
  tx.recentBlockhash = blockhash;
  tx.add(ix);
  const uniqueSigners = [payer, ...extraSigners].filter(
    (kp, i, arr) => arr.findIndex((k) => k.publicKey.equals(kp.publicKey)) === i
  );
  tx.sign(...uniqueSigners);
  const raw = tx.serialize();
  const sig = await rpc(() =>
    connection.sendRawTransaction(raw, {
      skipPreflight: false,
      preflightCommitment: "confirmed",
    })
  );
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { value } = await rpc(() => connection.getSignatureStatuses([sig]));
    const st = value[0];
    if (st) {
      if (st.err)
        throw new Error(`Transaction ${sig} failed: ${JSON.stringify(st.err)}`);
      if (
        st.confirmationStatus === "confirmed" ||
        st.confirmationStatus === "finalized"
      )
        return sig;
    }
    await sleep(pollIntervalMs);
  }
  throw new Error(`Transaction ${sig} was not confirmed within ${timeoutMs}ms`);
}

// ── Cost model ───────────────────────────────────────────────────────────────

const HOP_NAMES: Record<number, string> = {
  2: "migrate_v2_to_v3",
  3: "migrate_v3_to_v4",
  4: "migrate_v4_to_v5",
  5: "migrate_v5_to_v6",
};

interface VaultPlan {
  rec: Rec;
  hops: string[];
  rentDelta: number; // lamports the payer nets out (positive = payer pays)
  fees: number;
  needsSessionCarry: boolean;
}

function planVault(
  rec: Rec,
  rentMin: Map<number, number>,
  sigsPerTx: number,
  now: number
): VaultPlan {
  const hops: string[] = [];
  let lamports = rec.lamports;
  let rentDelta = 0;
  let needsSessionCarry = false;

  for (let v = rec.versionByte; v <= 5; v++) {
    hops.push(HOP_NAMES[v]);
    if (v < 5) {
      // grow hop: payer tops the vault up to rent-exemption at the new size
      const need = rentMin.get(GEN_SIZE[v + 1])!;
      const topUp = Math.max(0, need - lamports);
      rentDelta += topUp;
      lamports = Math.max(lamports, need);
    } else {
      // v5→v6 shrink: refund everything above rent-exemption at 279 B
      const live =
        rec.session?.some &&
        rec.session.expiresAt !== undefined &&
        rec.session.expiresAt > BigInt(now);
      if (live) {
        needsSessionCarry = true;
        rentDelta += rentMin.get(SESSION_ACCOUNT_SIZE)!; // payer funds the session PDA
      }
      const refund = Math.max(0, lamports - rentMin.get(V6_SIZE)!);
      rentDelta -= refund;
      lamports -= refund;
    }
  }
  const fees = hops.length * LAMPORTS_PER_SIG * sigsPerTx;
  return { rec, hops, rentDelta, fees, needsSessionCarry };
}

// ── Reporting helpers ────────────────────────────────────────────────────────

const SOL = (lamports: number) => (lamports / 1e9).toFixed(6);

function printCensus(recs: Rec[]): void {
  console.log(
    "\n══ CENSUS ═══════════════════════════════════════════════════"
  );
  const counts = new Map<string, number>();
  for (const r of recs) {
    const key =
      r.cls === "non-vault"
        ? `non-vault: ${r.clsDetail}`
        : `${r.cls.padEnd(15)} (${r.clsDetail})`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  for (const [k, v] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(v).padStart(4)}  ${k}`);
  }
  console.log(`  ${String(recs.length).padStart(4)}  TOTAL program accounts`);

  const excluded = recs.filter(
    (r) =>
      r.cls === "born-broken-279" || r.cls === "mismatch" || r.cls === "oddball"
  );
  if (excluded.length) {
    console.log(
      "\n── EXCLUDED vault-discriminator accounts (logged, never walked) ──"
    );
    for (const r of excluded) {
      console.log(`  ${r.pubkey.toBase58()}  ${r.cls}: ${r.clsDetail}`);
    }
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const cli = parseCli(process.argv.slice(2));

  if (cli.mode === "execute") {
    if (process.env.FLEET_MIGRATE_I_UNDERSTAND !== "yes") {
      console.error(
        "REFUSING --execute: set FLEET_MIGRATE_I_UNDERSTAND=yes to confirm you intend to send mainnet transactions."
      );
      process.exit(1);
    }
    if (!cli.payerKeypairPath) {
      console.error("--execute requires --payer-keypair <path>");
      process.exit(1);
    }
  }

  const authorityKeys = new Map<string, Keypair>();
  for (const p of cli.authorityKeypairPaths) {
    const kp = loadKeypair(p);
    authorityKeys.set(kp.publicKey.toBase58(), kp);
  }
  const payer = cli.payerKeypairPath
    ? loadKeypair(cli.payerKeypairPath)
    : undefined;

  console.log(`mode: ${cli.mode}`);
  console.log(
    `rpc:  ${RPC_URL.replace(
      /api-key=.*/,
      "api-key=***"
    )}  (max ${RPC_MAX_RPS} rps)`
  );
  console.log(`program: ${PROGRAM_ID.toBase58()}`);
  if (payer) console.log(`payer: ${payer.publicKey.toBase58()}`);
  if (authorityKeys.size)
    console.log(
      `authority keys loaded: ${[...authorityKeys.keys()].join(", ")}`
    );

  // ---- census (always; read-only) -----------------------------------------
  const recs = await census();
  printCensus(recs);

  const walkable = recs.filter(
    (r) =>
      r.walkable &&
      (cli.onlyVaults.size === 0 || cli.onlyVaults.has(r.pubkey.toBase58()))
  );

  if (cli.mode === "verify-only") {
    const journal = journalLoad();
    const done = recs.filter((r) => r.cls === "v6").length;
    console.log(
      `\nverify-only: ${done} vaults at V6, ${walkable.length} still pre-V6 walkable.`
    );
    console.log(`journal entries: ${journal.length} (${JOURNAL_PATH})`);
    const failures = journal.filter((j) => j.status === "failed");
    if (failures.length) {
      console.log(`journal failures: ${failures.length}`);
      for (const f of failures.slice(-20))
        console.log(`  ${f.vault} ${f.hop}: ${f.error}`);
    }
    return;
  }

  // ---- rent table -----------------------------------------------------------
  const sizes = [V6_SIZE, 289, 305, 341, 399, SESSION_ACCOUNT_SIZE];
  const rentMin = new Map<number, number>();
  for (const s of sizes) {
    rentMin.set(
      s,
      await rpc(() => connection.getMinimumBalanceForRentExemption(s))
    );
  }
  console.log("\n── Rent-exemption minimums ──");
  for (const s of [...rentMin.keys()].sort((a, b) => a - b)) {
    console.log(`  ${String(s).padStart(4)} B → ${SOL(rentMin.get(s)!)} SOL`);
  }

  // ---- authority grouping + plan ---------------------------------------------
  const now = Math.floor(Date.now() / 1000);
  // payer + dexter_authority sign each hop; 1 sig if they are the same key.
  const sigsFor = (r: Rec) =>
    payer && r.authority && payer.publicKey.equals(r.authority) ? 1 : 2;
  const plans = walkable.map((r) => planVault(r, rentMin, sigsFor(r), now));

  interface Group {
    authority: string;
    plans: VaultPlan[];
    haveKey: boolean;
  }
  const groups = new Map<string, Group>();
  for (const p of plans) {
    const a = p.rec.authority!.toBase58();
    if (!groups.has(a))
      groups.set(a, { authority: a, plans: [], haveKey: authorityKeys.has(a) });
    groups.get(a)!.plans.push(p);
  }

  console.log(
    "\n══ AUTHORITY GROUPING ═══════════════════════════════════════"
  );
  for (const g of [...groups.values()].sort(
    (a, b) => b.plans.length - a.plans.length
  )) {
    const byGen = new Map<string, number>();
    for (const p of g.plans)
      byGen.set(p.rec.cls, (byGen.get(p.rec.cls) ?? 0) + 1);
    const genStr = [...byGen.entries()]
      .sort()
      .map(([k, v]) => `${k}=${v}`)
      .join(" ");
    console.log(
      `  ${g.authority}  vaults=${String(g.plans.length).padStart(
        3
      )}  [${genStr}]  key=${g.haveKey ? "AVAILABLE" : "missing"}`
    );
  }
  const walkableWithKeys = plans.filter((p) =>
    authorityKeys.has(p.rec.authority!.toBase58())
  );
  console.log(
    `\n  walkable vaults: ${plans.length}   with signer available: ${walkableWithKeys.length}` +
      (authorityKeys.size === 0 ? "  (no --authority-keypair provided)" : "")
  );

  // ---- cost estimate ----------------------------------------------------------
  console.log(
    "\n══ COST / REFUND ESTIMATE (per cohort) ══════════════════════"
  );
  const cohorts = new Map<
    string,
    { n: number; hops: number; rent: number; fees: number; carries: number }
  >();
  for (const p of plans) {
    const c = cohorts.get(p.rec.cls) ?? {
      n: 0,
      hops: 0,
      rent: 0,
      fees: 0,
      carries: 0,
    };
    c.n++;
    c.hops += p.hops.length;
    c.rent += p.rentDelta;
    c.fees += p.fees;
    if (p.needsSessionCarry) c.carries++;
    cohorts.set(p.rec.cls, c);
  }
  let totRent = 0,
    totFees = 0,
    totHops = 0,
    totCarries = 0;
  for (const [cls, c] of [...cohorts.entries()].sort()) {
    console.log(
      `  ${cls}: ${String(c.n).padStart(3)} vaults  ${String(c.hops).padStart(
        4
      )} txs  ` +
        `rent ${c.rent >= 0 ? "+" : ""}${SOL(c.rent)} SOL  fees ${SOL(
          c.fees
        )} SOL` +
        (c.carries ? `  (${c.carries} live-session carries)` : "")
    );
    totRent += c.rent;
    totFees += c.fees;
    totHops += c.hops;
    totCarries += c.carries;
  }
  console.log(
    `\n  GRAND TOTAL: ${plans.length} vaults, ${totHops} transactions` +
      (totCarries ? `, ${totCarries} live-session carries` : "")
  );
  console.log(
    `    net rent delta for payer: ${totRent >= 0 ? "+" : ""}${SOL(
      totRent
    )} SOL`
  );
  console.log(`    tx fees:                   ${SOL(totFees)} SOL`);
  console.log(`    NET payer outlay:          ${SOL(totRent + totFees)} SOL`);
  console.log(
    "    (rent deltas computed from each vault's ACTUAL lamports; v5→v6 refunds excess to payer)"
  );

  const liveSessions = plans.filter((p) => p.needsSessionCarry);
  if (liveSessions.length) {
    console.log(
      "\n── Vaults whose CURRENT session is live (will need with_session at the v5→v6 hop) ──"
    );
    for (const p of liveSessions) {
      console.log(
        `  ${p.rec.pubkey.toBase58()}  expires_at=${
          p.rec.session!.expiresAt
        }  counterparty=${p.rec.session!.counterparty!.toBase58()}`
      );
    }
  }

  if (cli.mode === "dry-run") {
    console.log(
      "\ndry-run complete — no transactions were constructed or sent."
    );
    return;
  }

  // ════ EXECUTE MODE ══════════════════════════════════════════════════════════
  // (per the task: written, reviewed, but only ever run after explicit GO)

  const journal = journalLoad();
  console.log(
    `\njournal: ${journal.length} prior entries (chain state is truth; journal is audit)`
  );

  let queue = walkableWithKeys;
  if (cli.limit !== undefined) queue = queue.slice(0, cli.limit);
  console.log(`executing on ${queue.length} vault(s)…`);

  const failures: { vault: string; hop: string; error: string }[] = [];
  let migrated = 0;

  for (const plan of queue) {
    const vaultPk = plan.rec.pubkey;
    const vaultB58 = vaultPk.toBase58();
    const authority = authorityKeys.get(plan.rec.authority!.toBase58())!;
    try {
      // Walk hop-by-hop, re-reading the CHAIN before every hop (truth source).
      for (;;) {
        const info = await rpc(() =>
          connection.getAccountInfo(vaultPk, "confirmed")
        );
        if (!info) throw new Error("vault account vanished");
        const data = info.data as Buffer;
        const version = data[8];
        if (version === 6) break; // done
        if (version < 2 || version > 5)
          throw new Error(`unexpected version byte ${version} mid-walk`);
        if (data.length === V6_SIZE)
          throw new Error(
            `279 B mid-walk with version ${version} — refusing (born-broken shape)`
          );

        const hopName = HOP_NAMES[version];
        let ix: TransactionInstruction;
        if (version === 5) {
          const p = readPrefix(data);
          const session = readActiveSession(data, p.afterAuthority);
          const live =
            session.some &&
            session.expiresAt !== undefined &&
            session.expiresAt > BigInt(Math.floor(Date.now() / 1000));
          ix = live
            ? migrateV5ToV6WithSessionIx(
                vaultPk,
                authority.publicKey,
                payer!.publicKey,
                session.counterparty!
              )
            : migrateIx(
                "migrate_v5_to_v6",
                vaultPk,
                authority.publicKey,
                payer!.publicKey
              );
        } else {
          ix = migrateIx(
            hopName as any,
            vaultPk,
            authority.publicKey,
            payer!.publicKey
          );
        }

        // 3 attempts, fresh blockhash each; self-heal by re-reading the chain
        // (a landed-but-unconfirmed hop makes the resend revert with
        // UnsupportedVaultVersion — the version re-read disambiguates).
        let sent = false;
        let lastErr: any;
        for (let attempt = 0; attempt < 3 && !sent; attempt++) {
          try {
            const sig = await sendAndConfirmHttp(ix, payer!, [authority]);
            journalAppend({
              ts: new Date().toISOString(),
              vault: vaultB58,
              hop: hopName,
              fromVersion: version,
              toVersion: version + 1,
              sig,
              status: "confirmed",
            });
            console.log(`  ${vaultB58} ${hopName} → ${sig}`);
            sent = true;
          } catch (err: any) {
            lastErr = err;
            const msg = String(err?.message ?? err);
            // Did the hop actually land? Chain is truth.
            const after = await rpc(() =>
              connection.getAccountInfo(vaultPk, "confirmed")
            );
            if (after && (after.data as Buffer)[8] > version) {
              journalAppend({
                ts: new Date().toISOString(),
                vault: vaultB58,
                hop: hopName,
                fromVersion: version,
                toVersion: (after.data as Buffer)[8],
                status: "self-healed",
                error: msg.slice(0, 200),
              });
              console.log(
                `  ${vaultB58} ${hopName} self-healed (landed despite: ${msg.slice(
                  0,
                  80
                )})`
              );
              sent = true;
              break;
            }
            if (!isTransient(msg) || attempt === 2) throw err;
            await sleep(2000);
          }
        }
        if (!sent) throw lastErr;
      }

      // verify-after: version 6 + expected size
      const fin = await rpc(() =>
        connection.getAccountInfo(vaultPk, "confirmed")
      );
      const finData = fin?.data as Buffer;
      if (!fin || finData[8] !== 6 || finData.length !== V6_SIZE) {
        throw new Error(
          `post-walk verification FAILED: version=${finData?.[8]} size=${finData?.length}`
        );
      }
      journalAppend({
        ts: new Date().toISOString(),
        vault: vaultB58,
        hop: "verify",
        fromVersion: 6,
        toVersion: 6,
        status: "verified",
      });
      migrated++;
      console.log(
        `  ${vaultB58} VERIFIED v6 @ ${V6_SIZE} B  (${migrated}/${queue.length})`
      );
    } catch (err: any) {
      const msg = String(err?.message ?? err);
      failures.push({ vault: vaultB58, hop: "walk", error: msg });
      journalAppend({
        ts: new Date().toISOString(),
        vault: vaultB58,
        hop: "walk",
        fromVersion: plan.rec.versionByte,
        toVersion: 6,
        status: "failed",
        error: msg.slice(0, 500),
      });
      console.error(`  ${vaultB58} FAILED: ${msg}`);
      // failure isolation: continue with the next vault
    }
  }

  console.log(
    `\n══ EXECUTION SUMMARY ════════════════════════════════════════`
  );
  console.log(`  migrated+verified: ${migrated}/${queue.length}`);
  console.log(`  failures: ${failures.length}`);
  for (const f of failures) console.log(`    ${f.vault}: ${f.error}`);
  if (failures.length) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
