// migrate_legacy_to_v6 — POST-DEPLOY MAINNET PROOF SCRIPT (the stranded 7).
//
// ─────────────────────────────────────────────────────────────────────────────
// ⚠️  THIS IS NOT A PRE-DEPLOY TEST. It CANNOT run before the program build
//     containing `migrate_legacy_to_v6` is deployed: the legacy V1/V1.5
//     layouts are UNCONSTRUCTIBLE on any current build (initialize_vault has
//     stamped a version byte since V2), so there is nothing local to stage —
//     the ONLY inputs are the 7 real stranded mainnet accounts listed below.
//     Every it() here is a REAL CHAIN WRITE against a REAL account (two of
//     them belong to REAL USERS). Gated behind RUN_LEGACY_MIGRATION=1.
//
//     To run (AFTER Branch deploys the build with migrate_legacy_to_v6):
//
//       RUN_LEGACY_MIGRATION=1 \
//       ANCHOR_WALLET=$HOME/.config/solana/dexter-vault/upgrade-authority.json \
//       ANCHOR_PROVIDER_URL=<mainnet rpc> \
//       LEGACY_MASTER_KEYPAIR=<path to 3SWJTQ4FB... keypair, for the two 183B> \
//       npx ts-mocha -p ./tsconfig.json -t 600000 tests/migrate-legacy.ts
// ─────────────────────────────────────────────────────────────────────────────
//
// WHAT THIS PROVES (per vault):
//   1. PRE: the account is exactly 151 B (V1) or 183 B (V1.5) with the Vault
//      discriminator; snapshot it via the frozen raw decoder below (the TS
//      twin of `decode_legacy_vault` in migrate_legacy_to_v6.rs — these
//      layouts have NO version byte; byte 8 is the PDA bump).
//   2. WRITE: send migrate_legacy_to_v6. Authority signer:
//        - 183 B: the STORED dexter_authority must sign (LEGACY_MASTER_KEYPAIR
//          unless the stored authority IS the provider wallet).
//        - 151 B: LEGACY_MIGRATE_ADMIN (the upgrade-authority wallet — the
//          default ANCHOR_WALLET above) signs and is STAMPED as authority.
//   3. POST: re-read through the CURRENT V6 IDL decoder and assert
//      version == 6, size == 279, and every preserved field bit-for-bit:
//      bump, passkey, swig, cooling (i64→u32), pending_voucher_count,
//      pending_withdrawal, supabase_user_id → identity_claim[0..16] (+ zero
//      tail), dexter_authority per the gating, and ALL modern fields neutral.
//      For 7FE9VUea... specifically: the swig must be UNCHANGED — that swig
//      carries the user's real 1-USDC binding, and losing it is the failure
//      this whole migration exists to avoid.
//
// Idempotent re-runs: an already-migrated vault (279 B / version 6) is logged
// and skipped, so a partially-failed run can be re-fired safely.

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { DexterVault } from "../target/types/dexter_vault";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { createHash } from "crypto";
import { readFileSync } from "fs";
import { expect } from "chai";
import { makeTestProvider } from "./helpers/secp256r1";

// Anchor account discriminator for `Vault` = sha256("account:Vault")[..8].
const VAULT_DISCRIMINATOR = createHash("sha256")
  .update("account:Vault")
  .digest()
  .subarray(0, 8);

// Account sizes. Legacy V1 (no dexter_authority) = 151; V1.5 (+authority) =
// 183; current V6 = 8 + Vault::INIT_SPACE = 279.
const LEGACY_V1_LEN = 151;
const LEGACY_V15_LEN = 183;
const EXPECTED_V6_SIZE = 279;

// The hardcoded 151-byte gate/stamp wallet (== LEGACY_MIGRATE_ADMIN in
// migrate_legacy_to_v6.rs == the program upgrade authority).
const LEGACY_MIGRATE_ADMIN = new PublicKey(
  "X4o2kSLzqEQjnAzhq3L3BW92aawMV2n2F37EXd2GMpy"
);

// ── The stranded 7 (byte-level mainnet census 2026-06-10) ────────────────────
// Five 151-byte V1 relics (no stored authority — admin-claimed) and two
// 183-byte V1.5 vaults (REAL USERS — stored authority must sign).
const V1_VAULTS: string[] = [
  "4rCQW6yijKkiWrABxJHx26rpaGaLR83FJXerAbRL1tMP",
  "EUGAQGa1HqSs1nnUxmRPEjhFNqbmW5B4v2i3hCaMk3g2",
  "GuPj8Le6MxAMNxofdY9jrAMHFWqPnzbGVX6kMK8weRg8",
  "HvPKhdiAhL8K3175QxSSJZ82wZtDJwRRJNnLSA4WcAhL",
  "5Pisu1ukfWD3VmrBFVeBLpacxZtescyTHZMVsKb6RZmk",
];
const V15_VAULTS: string[] = [
  "7FE9VUeabi3sF8wUABV7F3eyvEi1ekDbER9k5JBYrWAi", // carries the 1-USDC swig binding
  "8sBhqhH1vsLL7uwycaALWdriK7NXkMSaZCijbnJRnhdV",
];

// ── Frozen raw legacy decoder (TS twin of decode_legacy_vault in Rust) ───────
//
// COMPACT Borsh cursor-walk; NO version byte exists (byte 8 is the PDA bump).
// Layout discrimination is STRICTLY by total length (151 vs 183). A Some
// pending_withdrawal shifts everything after it by +48, consuming the trailing
// zero slack exactly (87+48+16[+32] == the total), so the walk below handles
// both tags. Keep in lockstep with migrate_legacy_to_v6.rs.
interface LegacySnapshot {
  bump: number;
  passkeyPubkeyHex: string;
  swigAddress: string;
  coolingOffSeconds: bigint; // legacy i64 (modern field is u32)
  pendingVoucherCount: number;
  pendingWithdrawal: {
    amount: bigint;
    destination: string;
    requestedAt: bigint;
  } | null;
  supabaseUserIdHex: string; // 16 bytes (modern identity_claim is 32)
  storedAuthority: string | null; // null on the 151-byte V1 layout
  rawLen: number;
}

function decodeLegacyVault(buf: Buffer): LegacySnapshot {
  if (buf.length !== LEGACY_V1_LEN && buf.length !== LEGACY_V15_LEN) {
    throw new Error(
      `not a legacy vault: ${buf.length} bytes (expected 151 or 183)`
    );
  }
  if (!buf.subarray(0, 8).equals(VAULT_DISCRIMINATOR)) {
    throw new Error("not a Vault (discriminator mismatch)");
  }
  let o = 8;
  const bump = buf[o];
  o += 1;
  const passkeyPubkeyHex = buf.subarray(o, o + 33).toString("hex");
  o += 33;
  const swigAddress = new PublicKey(buf.subarray(o, o + 32)).toBase58();
  o += 32;
  const coolingOffSeconds = buf.readBigInt64LE(o); // i64 — NOT the modern u32
  o += 8;
  const pendingVoucherCount = buf.readUInt32LE(o);
  o += 4;
  const pwTag = buf[o];
  o += 1;
  let pendingWithdrawal: LegacySnapshot["pendingWithdrawal"] = null;
  if (pwTag === 1) {
    const amount = buf.readBigUInt64LE(o);
    o += 8;
    const destination = new PublicKey(buf.subarray(o, o + 32)).toBase58();
    o += 32;
    const requestedAt = buf.readBigInt64LE(o);
    o += 8;
    pendingWithdrawal = { amount, destination, requestedAt };
  } else if (pwTag !== 0) {
    throw new Error(`junk pending_withdrawal tag ${pwTag}`);
  }
  const supabaseUserIdHex = buf.subarray(o, o + 16).toString("hex");
  o += 16;
  let storedAuthority: string | null = null;
  if (buf.length === LEGACY_V15_LEN) {
    storedAuthority = new PublicKey(buf.subarray(o, o + 32)).toBase58();
    o += 32;
  }
  return {
    bump,
    passkeyPubkeyHex,
    swigAddress,
    coolingOffSeconds,
    pendingVoucherCount,
    pendingWithdrawal,
    supabaseUserIdHex,
    storedAuthority,
    rawLen: buf.length,
  };
}

// i64 → u32 clamp, mirroring encode_v6_image.
function clampCoolingToU32(v: bigint): number {
  if (v < 0n) return 0;
  if (v > 0xffffffffn) return 0xffffffff;
  return Number(v);
}

const runProof = process.env.RUN_LEGACY_MIGRATION === "1";
(runProof ? describe : describe.skip)(
  "migrate-legacy-to-v6: unstrand the V1/V1.5 cohort (CHAIN WRITE — requires the deployed migrate_legacy_to_v6 build)",
  function () {
    this.timeout(600000);

    const provider = makeTestProvider();
    const workspaceProgram = anchor.workspace.DexterVault as Program<DexterVault>;
    const program = new anchor.Program<DexterVault>(
      workspaceProgram.idl,
      provider
    );
    const providerWallet = provider.wallet.publicKey;

    // The two 183-byte vaults are gated by their STORED authority (the
    // production master 3SWJTQ4FB..., per the 2026-06-10 census), which is NOT
    // the upgrade wallet. Supply it via LEGACY_MASTER_KEYPAIR; a 183 vault
    // whose stored authority matches neither signer is SKIPPED loudly, never
    // attempted (the program would reject it anyway).
    const masterKp: Keypair | null = process.env.LEGACY_MASTER_KEYPAIR
      ? Keypair.fromSecretKey(
          Uint8Array.from(
            JSON.parse(readFileSync(process.env.LEGACY_MASTER_KEYPAIR, "utf8"))
          )
        )
      : null;

    // Inter-vault pacing on top of makeTestProvider's RPC rate limiter — the
    // same convention the other mainnet suites use between dependent writes.
    const pace = () => new Promise((r) => setTimeout(r, 1500));

    /** Migrate one vault end-to-end and prove every preserved field. */
    async function migrateAndProve(vaultStr: string): Promise<void> {
      const vault = new PublicKey(vaultStr);

      // (1) PRE: raw snapshot of the legacy account.
      const preAi = await provider.connection.getAccountInfo(vault);
      expect(preAi, `${vaultStr} not found on chain`).to.not.be.null;
      if (preAi!.data.length === EXPECTED_V6_SIZE) {
        // Idempotent re-run: already migrated. Verify the version and move on.
        const already = await program.account.vault.fetch(vault);
        expect(already.version).to.equal(6);
        console.log(`    ${vaultStr}: already V6 (279 B) — skipping`);
        return;
      }
      const pre = decodeLegacyVault(preAi!.data);
      console.log(
        `    ${vaultStr}: ${pre.rawLen} B legacy, bump=${pre.bump}, ` +
          `authority=${pre.storedAuthority ?? "(none — V1, admin claim)"}`
      );

      // (2) resolve the authority signer per the program's gating.
      let authoritySigner: Keypair | null; // null = the provider wallet signs
      let expectedAuthority: PublicKey;
      if (pre.storedAuthority === null) {
        // 151 B: LEGACY_MIGRATE_ADMIN must sign and is stamped as authority.
        expect(
          providerWallet.toBase58(),
          "151-byte path requires ANCHOR_WALLET == LEGACY_MIGRATE_ADMIN (the upgrade-authority wallet)"
        ).to.equal(LEGACY_MIGRATE_ADMIN.toBase58());
        authoritySigner = null;
        expectedAuthority = LEGACY_MIGRATE_ADMIN;
      } else {
        const stored = new PublicKey(pre.storedAuthority);
        if (stored.equals(providerWallet)) {
          authoritySigner = null;
        } else if (masterKp && masterKp.publicKey.equals(stored)) {
          authoritySigner = masterKp;
        } else {
          console.log(
            `    ${vaultStr}: SKIP — stored authority ${pre.storedAuthority} is neither ` +
              `the provider wallet nor LEGACY_MASTER_KEYPAIR; cannot sign the gate`
          );
          return;
        }
        expectedAuthority = stored;
      }

      // (3) WRITE: the migration itself.
      const builder = program.methods.migrateLegacyToV6({}).accountsPartial({
        vault,
        authority: authoritySigner ? authoritySigner.publicKey : providerWallet,
        payer: providerWallet,
        systemProgram: SystemProgram.programId,
      });
      if (authoritySigner) builder.signers([authoritySigner]);
      const sig = await builder.rpc();
      console.log(`    ${vaultStr}: migrated — ${sig}`);

      // (4) POST: read through the CURRENT V6 decoder and prove preservation.
      const postAi = await provider.connection.getAccountInfo(vault);
      expect(postAi!.data.length).to.equal(EXPECTED_V6_SIZE);
      const v6 = await program.account.vault.fetch(vault);

      expect(v6.version).to.equal(6);
      expect(v6.bump).to.equal(pre.bump);
      expect(Buffer.from(v6.passkeyPubkey).toString("hex")).to.equal(
        pre.passkeyPubkeyHex
      );
      expect(v6.swigAddress.toBase58()).to.equal(pre.swigAddress);
      expect(v6.coolingOffSeconds).to.equal(
        clampCoolingToU32(pre.coolingOffSeconds)
      );
      expect(v6.pendingVoucherCount).to.equal(pre.pendingVoucherCount);
      if (pre.pendingWithdrawal === null) {
        expect(v6.pendingWithdrawal).to.be.null;
      } else {
        expect(v6.pendingWithdrawal).to.not.be.null;
        expect(v6.pendingWithdrawal!.amount.toString()).to.equal(
          pre.pendingWithdrawal.amount.toString()
        );
        expect(v6.pendingWithdrawal!.destination.toBase58()).to.equal(
          pre.pendingWithdrawal.destination
        );
        expect(v6.pendingWithdrawal!.requestedAt.toString()).to.equal(
          pre.pendingWithdrawal.requestedAt.toString()
        );
      }
      // legacy 16-byte supabase_user_id → identity_claim[0..16], zero tail.
      const claimHex = Buffer.from(v6.identityClaim).toString("hex");
      expect(claimHex.slice(0, 32)).to.equal(pre.supabaseUserIdHex);
      expect(claimHex.slice(32)).to.equal("00".repeat(16));
      expect(v6.dexterAuthority.toBase58()).to.equal(
        expectedAuthority.toBase58()
      );
      // every modern-era field neutral.
      expect(v6.liveSessionCount).to.equal(0);
      expect(v6.outstandingLockedAmount.toNumber()).to.equal(0);
      expect(v6.totalCrystallizedAmount.toNumber()).to.equal(0);
      expect(v6.totalSettledAmount.toNumber()).to.equal(0);
      expect(v6.borrowed.toNumber()).to.equal(0);
      expect(v6.standbyBacker).to.be.null;
      expect(v6.standbyCap.toNumber()).to.equal(0);
      expect(v6.borrowRecoveryAt).to.be.null;
    }

    it("migrates the five 151-byte V1 relics under the admin claim", async () => {
      for (const v of V1_VAULTS) {
        await migrateAndProve(v);
        await pace();
      }
    });

    it("migrates the two 183-byte V1.5 user vaults under their stored authority", async () => {
      for (const v of V15_VAULTS) {
        await migrateAndProve(v);
        await pace();
      }
    });

    it("7FE9VUea keeps its 1-USDC swig binding (swig address unchanged across the migration)", async () => {
      // Census ground truth (2026-06-10, slot 425502493): the swig BEFORE the
      // migration. If the migration ran in the it() above, the account is V6
      // now — this re-asserts the binding against the hardcoded census value
      // so a swig-corrupting migration cannot slip through even on a re-run
      // where the legacy snapshot is no longer obtainable.
      const KNOWN_SWIG = "B4hHHypBQ7LuEXSdT3e9sWGGbbywcGSocju1C8VD3NFE";
      const v6 = await program.account.vault.fetch(
        new PublicKey("7FE9VUeabi3sF8wUABV7F3eyvEi1ekDbER9k5JBYrWAi")
      );
      expect(v6.version).to.equal(6);
      expect(v6.swigAddress.toBase58()).to.equal(KNOWN_SWIG);
    });
  }
);
