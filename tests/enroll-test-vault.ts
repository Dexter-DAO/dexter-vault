/**
 * Test-vault enrollment harness for the OTS e2e kit.
 *
 * Mirrors the enrollment portion of swig-settle-flow.ts (steps 1-3) but is
 * intended to be run as a one-shot script, not under mocha. After the
 * on-chain enrollment lands, posts to dexter-api's
 * /internal/admin/passkey-vault/register endpoint to insert the DB rows the
 * facilitator's lookupVaultBySwig() needs, then writes a credential JSON to
 * scripts/ots-e2e/test-credentials/<timestamp>.json and rewrites the kit's
 * config.json FILL_IN_AFTER_PHASE_1 block.
 *
 * The P256 keypair is generated locally — there's no browser passkey involved
 * because the on-chain secp256r1 precompile verifies signature math, not key
 * storage location. The math is real either way; what changes is reproducibility.
 *
 * Required env (read from dexter-facilitator/.env):
 *   - DEXTER_SESSION_MASTER_KEY (becomes the vault's dexter_authority + Swig role 2)
 *   - OTS_E2E_ADMIN_TOKEN (gates the /register endpoint)
 *   - HELIUS_RPC_URL (mainnet RPC)
 *
 * Required wallet: kit funder (= upgrade-authority key) at the path in
 * scripts/ots-e2e/config.json. Used as fee payer + Swig role 0 (bootstrap
 * manageAuthority).
 *
 * Run: npx ts-node --transpile-only dexter-vault/tests/enroll-test-vault.ts
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";

// Load env vars from dexter-facilitator/.env BEFORE any imports that touch
// process.env (makeTestProvider, etc.).
const FACILITATOR_ENV = "/home/branchmanager/websites/dexter-facilitator/.env";
const API_ENV = "/home/branchmanager/websites/dexter-api/.env";
function loadEnv(filePath: string) {
  if (!fs.existsSync(filePath)) return;
  const lines = fs.readFileSync(filePath, "utf8").split("\n");
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    const val = line.slice(eq + 1).trim().replace(/^"|"$/g, "");
    if (!(key in process.env)) process.env[key] = val;
  }
}
loadEnv(FACILITATOR_ENV);
loadEnv(API_ENV);

const KIT_CONFIG_PATH = "/home/branchmanager/websites/dexter-facilitator/scripts/ots-e2e/config.json";
const CRED_DIR = "/home/branchmanager/websites/dexter-facilitator/scripts/ots-e2e/test-credentials";

// Now set anchor env from kit config so makeTestProvider() picks them up.
const kitConfig = JSON.parse(fs.readFileSync(KIT_CONFIG_PATH, "utf8"));
process.env.ANCHOR_PROVIDER_URL = process.env.HELIUS_RPC_URL || process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";
process.env.ANCHOR_WALLET = kitConfig.funder.keypairFile;

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { DexterVault } from "../target/types/dexter_vault";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import bs58 from "bs58";

// @dexterai/vault@0.1.3+ has a fixed CJS bundle. dexter-vault's tsconfig uses
// `moduleResolution: node` (classic), which doesn't honor the package's
// `exports` map for static imports of subpaths. We resolve `@dexterai/vault/
// instructions` at runtime via indirect-eval dynamic import — bypasses TS
// module resolution entirely and lets Node's resolver handle the subpath.
// Type-wise the import is `any`; the script's only consumer is ts-node
// --transpile-only, so no static-typecheck coverage is lost.

import {
  generateP256Keypair,
  signOperationWithPasskey,
  buildSecp256r1VerifyInstruction,
  setSwigMessage,
  makeTestProvider,
  pollUntilAccountExists,
} from "./helpers/secp256r1";

// The kit/web3 type bridge swig-settle-flow.ts uses. Copied verbatim.
function kitIxToWeb3(kitIx: any): any {
  return {
    programId: new PublicKey(String(kitIx.programAddress)),
    keys: kitIx.accounts.map((a: any) => ({
      pubkey: new PublicKey(String(a.address)),
      isSigner: (a.role & 2) !== 0,
      isWritable: (a.role & 1) !== 0,
    })),
    data: Buffer.from(kitIx.data),
  };
}
function kitInstructionsToWeb3(kitIxs: any[]): any[] {
  return kitIxs.map(kitIxToWeb3);
}

async function main() {
  console.log("=== OTS e2e test-vault enrollment harness ===\n");

  // ── 0. Load secrets + funder ────────────────────────────────────
  const sessionMasterRaw = (process.env.DEXTER_SESSION_MASTER_KEY || "").trim();
  if (!sessionMasterRaw) throw new Error("DEXTER_SESSION_MASTER_KEY not set");
  const sessionSeed = Buffer.from(bs58.decode(sessionMasterRaw));
  if (sessionSeed.length !== 32) throw new Error(`session seed wrong length: ${sessionSeed.length}`);
  const sessionMaster = Keypair.fromSeed(sessionSeed);

  const otsToken = (process.env.OTS_E2E_ADMIN_TOKEN || "").trim();
  if (!otsToken) throw new Error("OTS_E2E_ADMIN_TOKEN not set");

  const provider = makeTestProvider();
  const program = anchor.workspace.DexterVault as Program<DexterVault>;
  const connection = provider.connection;
  const funder = (provider.wallet as anchor.Wallet).payer;

  console.log(`Funder       : ${funder.publicKey.toBase58()}`);
  console.log(`SessionMaster: ${sessionMaster.publicKey.toBase58()}`);
  console.log(`Vault program: ${program.programId.toBase58()}`);
  console.log(`RPC          : ${connection.rpcEndpoint}\n`);

  // Sanity: funder must hold SOL for the txs.
  const funderBalance = await connection.getBalance(funder.publicKey, "confirmed");
  console.log(`Funder SOL balance: ${(funderBalance / 1e9).toFixed(4)}`);
  if (funderBalance < 0.02e9) {
    throw new Error(`funder has <0.02 SOL (${funderBalance / 1e9}); top up before running`);
  }

  // ── 1. Generate identity + passkey ──────────────────────────────
  const passkey = generateP256Keypair();
  const userHandle = new Uint8Array(32);
  crypto.getRandomValues(userHandle);

  // Vault PDA derivation uses the leading 16 bytes of identity_claim.
  // Production uses a Supabase UUID; the harness uses the same 32-byte handle
  // for both identity_claim AND the user_vaults.user_handle column so the
  // DB row is internally consistent.
  const identityClaim = userHandle;
  const [vaultPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), Buffer.from(identityClaim.slice(0, 16))],
    program.programId,
  );
  console.log(`Vault PDA    : ${vaultPda.toBase58()}`);

  // ── 2. initialize_vault (cooling_off = 0 for tests) ─────────────
  console.log("\n→ initialize_vault");
  const initSig = await program.methods
    .initializeVault({
      passkeyPubkey: Array.from(passkey.publicKey),
      coolingOffSeconds: 0,
      identityClaim: Array.from(identityClaim),
    })
    .accountsPartial({
      vault: vaultPda,
      payer: funder.publicKey,
      dexterAuthority: sessionMaster.publicKey,
      systemProgram: SystemProgram.programId,
    })
    .signers([sessionMaster])
    .rpc();
  console.log(`  sig: ${initSig}`);
  await pollUntilAccountExists(connection, vaultPda);

  // ── 3. Create Swig with four authorities (atomic, via @dexterai/vault) ──
  // The package's buildSwigCreationBundle is the canonical 4-role provisioning
  // sequence used by dexter-api production enrollment. role 0 = funder
  // manageAuthority bootstrap; role 1 = ProgramExec(vault, finalize_withdrawal);
  // role 2 = session master Ed25519; role 3 = ProgramExec(vault,
  // settle_tab_voucher). If the on-chain role list ever changes, it changes
  // here in exactly one place — the test follows by definition.
  console.log("\n→ buildSwigCreationBundle (single atomic 4-role create)");
  // The hmacKey for swig-id derivation MUST be the same 32-byte session-master
  // seed production uses. We already loaded the 32-byte sessionSeed in step 0.
  const hmacKey = sessionSeed;

  // See top-of-file comment for why this uses dynamic import via indirect eval.
  const nativeImport = new Function("p", "return import(p)") as (
    p: string,
  ) => Promise<any>;
  const { buildSwigCreationBundle } = await nativeImport(
    "@dexterai/vault/instructions",
  );

  const bundle = await buildSwigCreationBundle({
    feePayer: funder.publicKey.toBase58(),
    dexterMasterPubkey: sessionMaster.publicKey.toBase58(),
    identitySeed: identityClaim,
    hmacKey,
  });
  const swigAddress = new PublicKey(bundle.swigAddress);
  console.log(`Swig address : ${swigAddress.toBase58()}`);

  const createBundleTx = new Transaction().add(...kitInstructionsToWeb3(bundle.instructions));
  const createBundleSig = await sendAndConfirmTransaction(connection, createBundleTx, [funder]);
  console.log(`  sig: ${createBundleSig}`);
  await pollUntilAccountExists(connection, swigAddress);

  // ── 4. set_swig — passkey signs ─────────────────────────────────
  console.log("\n→ set_swig (passkey-signed)");
  const setSwigOp = setSwigMessage(swigAddress);
  const setSwigSigned = signOperationWithPasskey(passkey, setSwigOp);
  const precompileIx = buildSecp256r1VerifyInstruction(
    passkey.publicKey,
    setSwigSigned.signature,
    setSwigSigned.precompileMessage,
  );
  const setSwigIx = await program.methods
    .setSwig({
      swigAddress,
      clientDataJson: Buffer.from(setSwigSigned.clientDataJSON),
      authenticatorData: Buffer.from(setSwigSigned.authenticatorData),
    })
    .accountsPartial({
      vault: vaultPda,
      instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
    })
    .instruction();
  const setSwigTx = new Transaction().add(precompileIx, setSwigIx);
  const setSwigSig = await sendAndConfirmTransaction(connection, setSwigTx, [funder]);
  console.log(`  sig: ${setSwigSig}`);

  // ── 5. Register in DB via dexter-api admin endpoint ─────────────
  console.log("\n→ POST /internal/admin/passkey-vault/register");
  const credentialId = `e2e-test-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
  const registerBody = {
    vaultPda: vaultPda.toBase58(),
    swigAddress: swigAddress.toBase58(),
    passkeyPublicKey: Buffer.from(passkey.publicKey).toString("base64"),
    userHandle: Buffer.from(userHandle).toString("base64"),
    credentialId,
    coolingOffSeconds: 0,
  };
  const apiBase = process.env.OTS_E2E_API_BASE || "https://api.dexter.cash";
  const registerRes = await fetch(`${apiBase}/internal/admin/passkey-vault/register`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-ots-e2e-token": otsToken },
    body: JSON.stringify(registerBody),
  });
  const registerJson = await registerRes.json().catch(() => ({}));
  if (!registerRes.ok || (registerJson as any).ok !== true) {
    throw new Error(`register failed: HTTP ${registerRes.status} ${JSON.stringify(registerJson)}`);
  }
  console.log(`  ok: alreadyRegistered=${(registerJson as any).alreadyRegistered}`);

  // ── 6. Persist credential + update kit config ───────────────────
  if (!fs.existsSync(CRED_DIR)) fs.mkdirSync(CRED_DIR, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const credPath = path.join(CRED_DIR, `${ts}-${credentialId}.json`);
  fs.writeFileSync(credPath, JSON.stringify({
    enrolledAt: new Date().toISOString(),
    credentialId,
    vaultPda: vaultPda.toBase58(),
    swigAddress: swigAddress.toBase58(),
    userHandleBase64: Buffer.from(userHandle).toString("base64"),
    passkeyPublicKeyBase64: Buffer.from(passkey.publicKey).toString("base64"),
    passkeyPrivateKeyBase64: Buffer.from(passkey.privateKey).toString("base64"),
    signatures: {
      initialize: initSig,
      swigCreationBundle: createBundleSig,
      setSwig: setSwigSig,
    },
  }, null, 2));
  console.log(`\nCredential written: ${credPath}`);

  // Update kit config.json's FILL_IN_AFTER_PHASE_1 block.
  kitConfig.FILL_IN_AFTER_PHASE_1 = {
    _note: `Scripted enrollment via enroll-test-vault.ts at ${new Date().toISOString()}. Credential: ${credPath}`,
    vault: vaultPda.toBase58(),
    buyerSwig: swigAddress.toBase58(),
    buyerWallet: swigAddress.toBase58(),
  };
  fs.writeFileSync(KIT_CONFIG_PATH, JSON.stringify(kitConfig, null, 2) + "\n");
  console.log(`Kit config updated: ${KIT_CONFIG_PATH}`);

  console.log("\n=== ENROLLMENT COMPLETE ===");
  console.log(`vault   : ${vaultPda.toBase58()}`);
  console.log(`swig    : ${swigAddress.toBase58()}`);
  console.log(`Next: cd dexter-facilitator && scripts/ots-e2e/run.sh fund && scripts/ots-e2e/run.sh tab && scripts/ots-e2e/run.sh verify`);
}

main().catch((err) => {
  console.error("\nENROLLMENT FAILED:", err?.stack || err);
  process.exit(1);
});
