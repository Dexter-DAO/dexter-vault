import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { DexterVault } from "../target/types/dexter_vault";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import { createHash } from "crypto";
import { expect } from "chai";
import { makeTestProvider } from "./helpers/secp256r1";

// =============================================================================
// migrate_v3_to_v4 — MAINNET MIGRATION PROOF (Some + None, bit-for-bit)
// =============================================================================
//
// This is the load-bearing verification for the V3→V4 migration. The migration
// is correct ONLY if a real V3 vault migrates to V4 with EVERY pre-existing
// field preserved bit-for-bit and all 5 new fields = 0. It mirrors the v2→v3
// proof that confirmed `EVuq1Vpe...` preserved its session through the realloc.
//
// ─────────────────────────────────────────────────────────────────────────────
// ⚠️  THIS TEST IS A CHAIN WRITE. IT HAS NOT BEEN RUN. DO NOT RUN IT until:
//      (a) Branch authorizes deploying the 15-instruction (V4) program build to
//          mainnet (`anchor upgrade` of Hg3wRaydFtJhYrdvYrKECacpJYDsC9Px7yKmpncj2fhc),
//      (b) Branch authorizes the migration tx on a real vault.
//     Until the program is deployed, the `migrateV3ToV4` instruction does not
//     exist on chain and the migration `describe` block will fail at the rpc()
//     call. The local "state shape" block below is pure type/IDL/math assertion
//     and is safe to run anytime.
// ─────────────────────────────────────────────────────────────────────────────
//
// WHY A RAW BYTE DECODE FOR THE PRE-MIGRATION SNAPSHOT
// ----------------------------------------------------
// A V3 account is 305 bytes. The CURRENT (V4) IDL decoder expects 341 bytes, so
// `program.account.vault.fetch()` on a still-V3 account would over-run / misread.
// We therefore record the pre-migration ground truth by RAW getAccountInfo +
// manual decode of the V3 byte layout (decodeVaultV3 below — a hand-frozen mirror
// of the V3 `Vault` / `SessionRegistration` layout, the TS twin of the frozen
// `VaultV3` / `SessionRegistrationV3` decoder in migrate_v3_to_v4.rs). AFTER the
// migration the account is 341 bytes and `program.account.vault.fetch()` (the V4
// decoder) reads it natively — that is the read-side of the proof.
//
// VAULT SELECTION (Option A — controllable vaults verified on mainnet 2026-06-05)
// ------------------------------------------------------------------------------
// getProgramAccounts found 8 V3 vaults (all 305 bytes). The upgrade wallet
// X4o2kSLzqEQjnAzhq3L3BW92aawMV2n2F37EXd2GMpy — the ANCHOR_WALLET this suite
// signs with — is the `dexter_authority` of 7 of them (5 Some, 2 None). Only
// EVuq1Vpe... is under the production master 3SWJTQ4FB.... So the test runs
// end-to-end with just the upgrade wallet; no production master key is required.
//
// Defaults below point at one controllable Some vault and one controllable None
// vault. Both are overridable via env (MIGRATE_V3_SOME_VAULT /
// MIGRATE_V3_NONE_VAULT) so Branch can retarget at run time. The signer must be
// the vault's dexter_authority; the default vaults are authored by the upgrade
// wallet, so the provider wallet signs as both `dexterAuthority` and `payer`.
// =============================================================================

// Anchor account discriminator for `Vault` = sha256("account:Vault")[..8].
const VAULT_DISCRIMINATOR = createHash("sha256")
  .update("account:Vault")
  .digest()
  .subarray(0, 8);

// Controllable V3 vaults under the upgrade wallet's authority (verified on
// mainnet). Override via env to retarget at run time.
const SOME_VAULT = new PublicKey(
  process.env.MIGRATE_V3_SOME_VAULT ||
    "5p6YypHTwNvbwxw5ijiv76xVTGH9vckavD5UPJxM5jPd"
);
const NONE_VAULT = new PublicKey(
  process.env.MIGRATE_V3_NONE_VAULT ||
    "3o9Hmh3C3Tb9dW95ZnGJnfmTKes3XvpxUGYp4Wi18oim"
);

// Expected V4 account size: V3 was 305 bytes (8 disc + 297 V3 INIT_SPACE).
// V4 adds 12 (session: crystallized_cumulative u64 + last_locked_sequence u32)
// + 24 (vault: 3× u64) = +36 → 297 + 36 = 333 INIT_SPACE → 8 + 333 = 341 bytes.
const EXPECTED_V4_SIZE = 341;
const V3_SIZE = 305;

// ── Raw V3 byte decoder (TS twin of the frozen VaultV3 decoder in Rust) ──────
//
// Mirrors the V3 on-chain layout EXACTLY. Used ONLY to snapshot a 305-byte V3
// account before migration (the V4 IDL decoder cannot read it). Returns the
// decoded prefix + session as base58 / bigint / number so the post-migration
// V4-decoded values can be compared against it. Any drift here vs. the real V3
// layout would make the proof lie — keep it in lockstep with state.rs-as-of-V3.
interface VaultV3Snapshot {
  version: number;
  bump: number;
  passkeyPubkeyHex: string;
  swigAddress: string;
  coolingOffSeconds: number;
  pendingVoucherCount: number;
  pendingWithdrawal: {
    amount: bigint;
    destination: string;
    requestedAt: bigint;
  } | null;
  identityClaimHex: string;
  dexterAuthority: string;
  activeSession: {
    sessionPubkeyHex: string;
    maxAmount: bigint;
    expiresAt: bigint;
    allowedCounterparty: string;
    nonce: number;
    spent: bigint;
    currentOutstanding: bigint;
    maxRevolvingCapacity: bigint;
  } | null;
  rawLen: number;
}

function decodeVaultV3(buf: Buffer): VaultV3Snapshot {
  if (!buf.subarray(0, 8).equals(VAULT_DISCRIMINATOR)) {
    throw new Error("account is not a Vault (discriminator mismatch)");
  }
  let o = 8;
  const version = buf[o];
  o += 1;
  const bump = buf[o];
  o += 1;
  const passkeyPubkeyHex = buf.subarray(o, o + 33).toString("hex");
  o += 33;
  const swigAddress = new PublicKey(buf.subarray(o, o + 32)).toBase58();
  o += 32;
  const coolingOffSeconds = buf.readUInt32LE(o);
  o += 4;
  const pendingVoucherCount = buf.readUInt32LE(o);
  o += 4;

  // pending_withdrawal: Option<PendingWithdrawal { amount:u64, destination:[u8;32], requested_at:i64 }>
  const pwTag = buf[o];
  o += 1;
  let pendingWithdrawal: VaultV3Snapshot["pendingWithdrawal"] = null;
  if (pwTag === 1) {
    const amount = buf.readBigUInt64LE(o);
    o += 8;
    const destination = new PublicKey(buf.subarray(o, o + 32)).toBase58();
    o += 32;
    const requestedAt = buf.readBigInt64LE(o);
    o += 8;
    pendingWithdrawal = { amount, destination, requestedAt };
  }

  const identityClaimHex = buf.subarray(o, o + 32).toString("hex");
  o += 32;
  const dexterAuthority = new PublicKey(buf.subarray(o, o + 32)).toBase58();
  o += 32;

  // active_session: Option<SessionRegistrationV3>
  const sTag = buf[o];
  o += 1;
  let activeSession: VaultV3Snapshot["activeSession"] = null;
  if (sTag === 1) {
    const sessionPubkeyHex = buf.subarray(o, o + 32).toString("hex");
    o += 32;
    const maxAmount = buf.readBigUInt64LE(o);
    o += 8;
    const expiresAt = buf.readBigInt64LE(o);
    o += 8;
    const allowedCounterparty = new PublicKey(
      buf.subarray(o, o + 32)
    ).toBase58();
    o += 32;
    const nonce = buf.readUInt32LE(o);
    o += 4;
    const spent = buf.readBigUInt64LE(o);
    o += 8;
    const currentOutstanding = buf.readBigUInt64LE(o);
    o += 8;
    const maxRevolvingCapacity = buf.readBigUInt64LE(o);
    o += 8;
    activeSession = {
      sessionPubkeyHex,
      maxAmount,
      expiresAt,
      allowedCounterparty,
      nonce,
      spent,
      currentOutstanding,
      maxRevolvingCapacity,
    };
  }

  return {
    version,
    bump,
    passkeyPubkeyHex,
    swigAddress,
    coolingOffSeconds,
    pendingVoucherCount,
    pendingWithdrawal,
    identityClaimHex,
    dexterAuthority,
    activeSession,
    rawLen: buf.length,
  };
}

// ── (A) LOCAL ASSERTIONS — no chain. Safe to run anytime. ────────────────────
describe("migrate-v3-to-v4: state shape + size math (local, no chain)", () => {
  const program = anchor.workspace.DexterVault as Program<DexterVault>;

  it("IDL exposes the migrate_v3_to_v4 instruction (V4 program build)", () => {
    const idl = program.idl as any;
    const names = idl.instructions.map((i: any) => i.name);
    // Anchor camelCases instruction names in the in-memory IDL.
    expect(names).to.include("migrateV3ToV4");
  });

  it("IDL Vault carries the 3 new V4 vault-scope odometers", () => {
    const idl = program.idl as any;
    const v = idl.types.find((t: any) => t.name === "vault");
    const fields = v.type.fields.map((f: any) => f.name);
    expect(fields).to.include("outstandingLockedAmount");
    expect(fields).to.include("totalCrystallizedAmount");
    expect(fields).to.include("totalSettledAmount");
  });

  it("IDL SessionRegistration carries the 2 new V4 session odometers", () => {
    const idl = program.idl as any;
    const s = idl.types.find((t: any) => t.name === "sessionRegistration");
    const fields = s.type.fields.map((f: any) => f.name);
    expect(fields).to.include("crystallizedCumulative");
    expect(fields).to.include("lastLockedSequence");
  });

  it("V4 account size math: 305 (V3) + 36 (12 session + 24 vault) = 341", () => {
    // V3:  8 disc + 297 INIT_SPACE = 305
    // +12: SessionRegistration crystallized_cumulative(u64) + last_locked_sequence(u32)
    // +24: Vault outstanding_locked_amount + total_crystallized_amount + total_settled_amount (3× u64)
    expect(V3_SIZE + 12 + 24).to.equal(EXPECTED_V4_SIZE);
  });
});

// ── (B) MAINNET MIGRATION PROOF — CHAIN WRITE. Gated on Branch's deploy go. ───
//
// Skipped unless RUN_MIGRATION_PROOF=1 so the local "state shape" block above
// can be executed in CI / type-check runs WITHOUT firing a migration tx. To run
// the proof (AFTER Branch deploys the V4 program):
//
//   RUN_MIGRATION_PROOF=1 \
//   ANCHOR_WALLET=$HOME/.config/solana/dexter-vault/upgrade-authority.json \
//   ANCHOR_PROVIDER_URL=https://api.mainnet-beta.solana.com \
//   npx ts-mocha -p ./tsconfig.json -t 600000 tests/migrate-v3-to-v4.ts
//
const runProof = process.env.RUN_MIGRATION_PROOF === "1";
(runProof ? describe : describe.skip)(
  "migrate-v3-to-v4: mainnet migration proof (CHAIN WRITE — requires deployed V4 program)",
  function () {
    this.timeout(600000);

    const provider = makeTestProvider();
    const program = anchor.workspace.DexterVault as Program<DexterVault>;
    const signer = provider.wallet.publicKey;

    it("Some-session vault: every prefix + session field preserved bit-for-bit, 5 new fields = 0", async () => {
      // (1) PRE: raw-decode the still-V3 (305-byte) account.
      const preAi = await provider.connection.getAccountInfo(SOME_VAULT);
      expect(preAi, `vault ${SOME_VAULT.toBase58()} not found`).to.not.be.null;
      expect(preAi!.data.length).to.equal(
        V3_SIZE,
        "pre-migration account is not 305 bytes — is it already migrated?"
      );
      const pre = decodeVaultV3(preAi!.data);
      expect(pre.version).to.equal(3, "selected vault is not V3");
      expect(pre.activeSession, "selected vault must be Some-session").to.not.be
        .null;
      expect(pre.dexterAuthority).to.equal(
        signer.toBase58(),
        "signer is not this vault's dexter_authority — retarget MIGRATE_V3_SOME_VAULT or fix the wallet"
      );

      // (2) MIGRATE.
      await program.methods
        .migrateV3ToV4({})
        .accountsPartial({
          vault: SOME_VAULT,
          dexterAuthority: signer,
          payer: signer,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      // (3) POST: the account is now 341 bytes; the V4 IDL decoder reads it.
      const postAi = await provider.connection.getAccountInfo(SOME_VAULT);
      expect(postAi!.data.length).to.equal(
        EXPECTED_V4_SIZE,
        "post-migration account is not the expected V4 size (341)"
      );
      const post = await program.account.vault.fetch(SOME_VAULT);

      // (4a) version bumped.
      expect(post.version).to.equal(4);

      // (4b) prefix fields preserved bit-for-bit.
      expect(post.bump).to.equal(pre.bump);
      expect(Buffer.from(post.passkeyPubkey).toString("hex")).to.equal(
        pre.passkeyPubkeyHex
      );
      expect(post.swigAddress.toBase58()).to.equal(pre.swigAddress);
      expect(post.coolingOffSeconds).to.equal(pre.coolingOffSeconds);
      expect(post.pendingVoucherCount).to.equal(pre.pendingVoucherCount);
      if (pre.pendingWithdrawal === null) {
        expect(post.pendingWithdrawal).to.be.null;
      } else {
        expect(post.pendingWithdrawal).to.not.be.null;
        expect(post.pendingWithdrawal!.amount.toString()).to.equal(
          pre.pendingWithdrawal.amount.toString()
        );
        expect(post.pendingWithdrawal!.destination.toBase58()).to.equal(
          pre.pendingWithdrawal.destination
        );
        expect(post.pendingWithdrawal!.requestedAt.toString()).to.equal(
          pre.pendingWithdrawal.requestedAt.toString()
        );
      }
      expect(Buffer.from(post.identityClaim).toString("hex")).to.equal(
        pre.identityClaimHex
      );
      expect(post.dexterAuthority.toBase58()).to.equal(pre.dexterAuthority);

      // (4c) THE BIT-FOR-BIT SESSION PROOF: every pre-existing session field
      //      survived the interior +12-byte growth unchanged.
      const s = post.activeSession!;
      const ps = pre.activeSession!;
      expect(s, "session must still be Some after migration").to.not.be.null;
      expect(Buffer.from(s.sessionPubkey).toString("hex")).to.equal(
        ps.sessionPubkeyHex
      );
      expect(s.maxAmount.toString()).to.equal(ps.maxAmount.toString());
      expect(s.expiresAt.toString()).to.equal(ps.expiresAt.toString());
      expect(s.allowedCounterparty.toBase58()).to.equal(ps.allowedCounterparty);
      expect(s.nonce).to.equal(ps.nonce);
      expect(s.spent.toString()).to.equal(ps.spent.toString());
      expect(s.currentOutstanding.toString()).to.equal(
        ps.currentOutstanding.toString()
      );
      expect(s.maxRevolvingCapacity.toString()).to.equal(
        ps.maxRevolvingCapacity.toString()
      );

      // (4d) the 2 new session fields = 0 (legacy session never locked).
      expect(s.crystallizedCumulative.toString()).to.equal("0");
      expect(s.lastLockedSequence).to.equal(0);

      // (4e) the 3 new vault-scope odometers = 0 (no lock accounting yet).
      expect(post.outstandingLockedAmount.toString()).to.equal("0");
      expect(post.totalCrystallizedAmount.toString()).to.equal("0");
      expect(post.totalSettledAmount.toString()).to.equal("0");
    });

    it("None-session vault: prefix preserved, version bumped, 3 vault fields = 0, no session", async () => {
      // (1) PRE: raw-decode the still-V3 account.
      const preAi = await provider.connection.getAccountInfo(NONE_VAULT);
      expect(preAi, `vault ${NONE_VAULT.toBase58()} not found`).to.not.be.null;
      expect(preAi!.data.length).to.equal(V3_SIZE);
      const pre = decodeVaultV3(preAi!.data);
      expect(pre.version).to.equal(3, "selected vault is not V3");
      expect(pre.activeSession, "selected vault must be None-session").to.be
        .null;
      expect(pre.dexterAuthority).to.equal(
        signer.toBase58(),
        "signer is not this vault's dexter_authority — retarget MIGRATE_V3_NONE_VAULT or fix the wallet"
      );

      // (2) MIGRATE.
      await program.methods
        .migrateV3ToV4({})
        .accountsPartial({
          vault: NONE_VAULT,
          dexterAuthority: signer,
          payer: signer,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      // (3) POST.
      const postAi = await provider.connection.getAccountInfo(NONE_VAULT);
      expect(postAi!.data.length).to.equal(EXPECTED_V4_SIZE);
      const post = await program.account.vault.fetch(NONE_VAULT);

      // (4a) version bumped.
      expect(post.version).to.equal(4);

      // (4b) prefix preserved bit-for-bit.
      expect(post.bump).to.equal(pre.bump);
      expect(Buffer.from(post.passkeyPubkey).toString("hex")).to.equal(
        pre.passkeyPubkeyHex
      );
      expect(post.swigAddress.toBase58()).to.equal(pre.swigAddress);
      expect(post.coolingOffSeconds).to.equal(pre.coolingOffSeconds);
      expect(post.pendingVoucherCount).to.equal(pre.pendingVoucherCount);
      expect(Buffer.from(post.identityClaim).toString("hex")).to.equal(
        pre.identityClaimHex
      );
      expect(post.dexterAuthority.toBase58()).to.equal(pre.dexterAuthority);

      // (4c) still no session.
      expect(post.activeSession).to.be.null;

      // (4d) the 3 new vault-scope odometers = 0.
      expect(post.outstandingLockedAmount.toString()).to.equal("0");
      expect(post.totalCrystallizedAmount.toString()).to.equal("0");
      expect(post.totalSettledAmount.toString()).to.equal("0");
    });
  }
);
