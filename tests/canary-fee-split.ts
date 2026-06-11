/**
 * CANARY: facilitator tab-settle FEE SPLIT against the DEPLOYED mainnet Swig.
 *
 * THE SHIP GATE. The facilitator (live at FACILITATOR_URL) now builds tab
 * settles as ONE Swig SignV2 carrying TWO inner TransferChecked instructions
 * when TAB_FEE_RECIPIENT is set: seller gets T − fee, the revenue ATA gets
 * fee. That multi-inner-instruction behavior was verified against the PINNED
 * Swig SOURCE (rev c2e8eb4) but never executed against the DEPLOYED mainnet
 * binary — this canary proves it with ~$0.01 of real USDC. A failed settle
 * reverts atomically (no funds move), so failure is harmless.
 *
 * VAULT: the OTS-e2e enrolled test vault (EbMJ…) — the ONLY local vault that
 * can clear the facilitator's gates without a human tap:
 *   - its passkey lives in a local credential JSON (ceremony signed locally),
 *   - its dexter_authority IS the facilitator's session master (3SWJ…),
 *   - its Swig carries the 4-role production layout (role 3 = ProgramExec
 *     settle_tab_voucher marker the facilitator hardcodes).
 * prove-sdk-v6's bootstrapForRegister vaults CANNOT settle through the live
 * facilitator (2-role swig, wrong dexter_authority, test mint) — so this rig
 * steals prove-sdk-v6's register/sign/revoke machinery but points it at the
 * enrolled vault, and prove-leg2's HTTP-settle + poll-as-assertion patterns.
 *
 * RUN (orchestrator only — REAL run spends ~$0.01 USDC from the test vault):
 *   cd dexter-vault && \
 *   npx ts-mocha -p ./tsconfig.json -t 600000 tests/canary-fee-split.ts
 *
 * DRY (read-only smoke — preconditions only, NOTHING is registered/settled):
 *   cd dexter-vault && \
 *   CANARY_DRY=1 npx ts-mocha -p ./tsconfig.json -t 600000 tests/canary-fee-split.ts
 *
 * Optional env overrides: HELIUS_RPC_URL, FACILITATOR_URL, CANARY_PAYER,
 * CANARY_CREDENTIAL_FILE.
 *
 * PRE-FUNDING: the vault's swig USDC ATA must hold ≥ 20,000 atomic ($0.02).
 * Test 0 fails fast with the exact ATA address if it doesn't.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { expect } from "chai";
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  getAccount,
} from "@solana/spl-token";
import { fetchSwig, getSwigWalletAddress } from "@swig-wallet/kit";
import { createSolanaRpc, address as kitAddress } from "@solana/kit";

import {
  sessionRegisterMessage,
  sessionRevokeMessage,
  buildVoucherMessage,
} from "@dexterai/vault/messages";
import {
  buildRegisterSessionKeyInstruction,
  buildRevokeSessionKeyInstruction,
} from "@dexterai/vault/instructions";
import {
  fetchSessionAccount,
  fetchVaultSessionAccounts,
  sessionPdasOf,
  waitForSession,
  isSessionLive,
} from "@dexterai/vault/session";
import { readVaultFull } from "@dexterai/vault/reader";
import { DEXTER_VAULT_PROGRAM_ID } from "@dexterai/vault/constants";
import { NodeEd25519Signer } from "@dexterai/vault/signers/node";

import {
  signOperationWithPasskey,
  buildSecp256r1VerifyInstruction,
  type P256Keypair,
} from "./helpers/secp256r1";

// ── Constants (env-overridable; Helius ONLY, never mainnet-beta) ────────────
const RPC =
  process.env.HELIUS_RPC_URL ??
  "https://mainnet.helius-rpc.com/?api-key=8fd1a2cd-76e7-4462-b38b-1026960edd40";
const FACILITATOR_URL = process.env.FACILITATOR_URL ?? "https://x402.dexter.cash";
const SOLANA_MAINNET_CAIP2 = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const USDC_MAINNET = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const VAULT_PROGRAM = "Hg3wRaydFtJhYrdvYrKECacpJYDsC9Px7yKmpncj2fhc";
const REVENUE_WALLET = new PublicKey("TabsikY2gKPbtLyg5WLExwpDjc4sdfnkQSBu5JZmqsG");
const REVENUE_ATA = new PublicKey("4FJJcb4NFNEPiwekPRjQ7KXHAYkzQ4CaN2WKwCVXvFPC");

/** The OTS-e2e enrolled test vault credential (passkey private key + vault +
 *  swig). Written by tests/enroll-test-vault.ts; machine-local by design. */
const CREDENTIAL_FILE =
  process.env.CANARY_CREDENTIAL_FILE ??
  "/home/branchmanager/websites/dexter-facilitator/scripts/ots-e2e/test-credentials/2026-06-05T23-11-28-918Z-e2e-test-1780701079880-c743910c.json";
const PAYER_PATH =
  process.env.CANARY_PAYER ?? "~/.config/solana/dexter-vault/upgrade-authority.json";

const VOUCHER_AMOUNT = 10_000n; // $0.01 — the canary's whole spend
const CAP_TARGET = 100_000n;    // session cap ceiling; shrunk to fit headroom
const MIN_SWIG_USDC = 20_000n;  // $0.02 — precondition floor
const SESSION_TTL_S = 3600n;    // ~1h expiry

/** Dry mode: test 0 (read-only preconditions) runs; tests 1+ skip. NOTHING is
 *  registered, settled, or transferred when set. */
const DRY = !!process.env.CANARY_DRY && process.env.CANARY_DRY !== "0";

// __dirname is unavailable: mocha reparses this file as an ES module (module
// syntax detected, no "type" in package.json). The run command cd's to the
// repo root, so anchor on cwd — same convention as prove-leg2-e2e.ts.
const TESTS_DIR = path.join(process.cwd(), "tests");
const RECEIPTS_FILE = path.join(
  TESTS_DIR,
  `.canary-fee-split-receipts-${Date.now()}.json`,
);

const receipts: Record<string, unknown> = {};
function receipt(key: string, value: unknown) {
  receipts[key] = value;
  console.log(`[receipt] ${key}:`, value);
  fs.writeFileSync(RECEIPTS_FILE, JSON.stringify(receipts, null, 2));
}

function loadKeypair(p: string): Keypair {
  const resolved = p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p;
  return Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(resolved, "utf8"))),
  );
}

async function sendSigned(
  conn: Connection,
  ixs: TransactionInstruction[],
  signers: Keypair[],
): Promise<string> {
  const tx = new Transaction().add(...ixs);
  tx.feePayer = signers[0].publicKey;
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  tx.sign(...signers);
  const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false });
  const c = await conn.confirmTransaction(
    { signature: sig, blockhash, lastValidBlockHeight },
    "confirmed",
  );
  if (c.value.err) throw new Error(`tx failed on-chain: ${JSON.stringify(c.value.err)}`);
  return sig;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("CANARY: facilitator fee split lands on the DEPLOYED mainnet Swig", function () {
  this.timeout(600_000);

  let conn: Connection;
  let vaultPda: PublicKey;
  let swigAddress: PublicKey;
  let swigWalletAddress: PublicKey;
  let swigAta: PublicKey;
  let passkey: P256Keypair;
  let payer: Keypair;
  let cap = CAP_TARGET; // shrunk to overcommit headroom in test 0

  // Fresh per run, like the rigs — no reuse (the aborted-prior-run trap).
  const seller = Keypair.generate();   // counterparty; receives net
  const session = Keypair.generate();  // ephemeral session key; signs the voucher
  let sellerAta: PublicKey;

  // Voucher state (test 2) → settle response state (test 4) → proof (test 5).
  let channelId: Buffer;
  let sessionSignature: Uint8Array;
  const cumulative = VOUCHER_AMOUNT; // fresh session ⇒ spent=0 ⇒ gross = cumulative
  let gross = 0n;
  let fee = 0n;
  let net = 0n;
  let settleTx = "";

  // Balances BEFORE (test 3).
  let sellerBefore = 0n;
  let revenueBefore = 0n;
  let swigBefore = 0n;

  // Set at the END of test 0. Mocha keeps running later `it`s after a
  // failure; this flag guarantees a failed precondition can never cascade
  // into an on-chain register/settle. gate() is every spending test's first
  // line: skip in dry mode, HARD-FAIL (not skip) if preconditions failed so
  // the run can't be mistaken for a pass.
  let preflightOk = false;
  function gate(ctx: Mocha.Context): boolean {
    if (DRY) {
      ctx.skip();
      return false;
    }
    if (!preflightOk) throw new Error("preconditions (test 0) did not pass — refusing to spend");
    return true;
  }

  after(() => {
    console.log("\nALL RECEIPTS:", JSON.stringify(receipts, null, 2));
    console.log(`(also written to ${RECEIPTS_FILE})`);
  });

  it("0. preconditions (read-only): facilitator, vault, funding, revenue ATA", async function () {
    this.timeout(180_000);
    expect(RPC, "RPC must be Helius — NEVER mainnet-beta (hard constraint)").to.match(/helius/);
    expect(
      DEXTER_VAULT_PROGRAM_ID.toBase58(),
      "SDK constants drifted from the pinned vault program",
    ).to.equal(VAULT_PROGRAM);
    conn = new Connection(RPC, "confirmed");

    // The enrolled credential: vault + swig + LOCALLY-SIGNABLE passkey.
    expect(fs.existsSync(CREDENTIAL_FILE), `credential file missing: ${CREDENTIAL_FILE}`).to.equal(true);
    const cred = JSON.parse(fs.readFileSync(CREDENTIAL_FILE, "utf8"));
    vaultPda = new PublicKey(cred.vaultPda);
    swigAddress = new PublicKey(cred.swigAddress);
    passkey = {
      publicKey: new Uint8Array(Buffer.from(cred.passkeyPublicKeyBase64, "base64")),
      privateKey: new Uint8Array(Buffer.from(cred.passkeyPrivateKeyBase64, "base64")),
    };
    expect(passkey.publicKey.length, "compressed P256 pubkey").to.equal(33);
    expect(passkey.privateKey.length, "P256 private scalar").to.equal(32);
    receipt("testVault", vaultPda.toBase58());
    receipt("credentialFile", CREDENTIAL_FILE);

    // Payer: harness fees + seller-ATA rent (same key the rigs use).
    payer = loadKeypair(PAYER_PATH);
    const payerSol = await conn.getBalance(payer.publicKey, "confirmed");
    receipt("payer", { pubkey: payer.publicKey.toBase58(), sol: payerSol / 1e9 });
    expect(payerSol, `payer ${payer.publicKey.toBase58()} needs ≥ 0.005 SOL for fees + ATA rent`).to.be.greaterThan(5_000_000);

    // The live facilitator must advertise the tab scheme on solana mainnet.
    const supRes = await fetch(`${FACILITATOR_URL}/supported`);
    expect(supRes.status, `${FACILITATOR_URL}/supported unreachable`).to.equal(200);
    const sup = (await supRes.json()) as { kinds?: Array<{ scheme?: string; network?: string; extra?: Record<string, unknown> }> };
    const tabKind = (sup.kinds ?? []).find(
      (k) => k.scheme === "tab" && k.network === SOLANA_MAINNET_CAIP2,
    );
    expect(tabKind, "facilitator /supported does not advertise scheme=tab on solana mainnet").to.not.equal(undefined);
    expect(tabKind!.extra?.settleUrl).to.equal("/tab/settle");
    receipt("supportedTabKind", tabKind);

    // Vault: exists, V6, swig matches the credential, authority present (the
    // facilitator 403s dexter_authority_mismatch unless the vault's authority
    // IS its session master — this vault was enrolled exactly that way).
    const vault = await readVaultFull(conn, vaultPda);
    expect(vault.exists, "test vault must exist on-chain").to.equal(true);
    expect(vault.version, "vault must be V6 (settle_tab_voucher hard-requires it)").to.equal(6);
    expect(vault.swigAddress).to.equal(swigAddress.toBase58());
    expect(vault.dexterAuthority, "vault has no dexter_authority").to.be.a("string");
    receipt("vaultState", {
      version: vault.version,
      dexterAuthority: vault.dexterAuthority,
      swigAddress: vault.swigAddress,
      liveSessionCount: vault.liveSessionCount,
    });

    // Swig wallet + USDC funding — THE RECEIPT + the fail-fast gate.
    const rpc: any = createSolanaRpc(RPC);
    const swig = await fetchSwig(rpc, kitAddress(swigAddress.toBase58()));
    expect(swig, "swig not on-chain").to.not.equal(null);
    swigWalletAddress = new PublicKey(String(await getSwigWalletAddress(swig)));
    swigAta = getAssociatedTokenAddressSync(USDC_MAINNET, swigWalletAddress, true);
    const swigBal = await getAccount(conn, swigAta).then((a) => a.amount).catch(() => -1n);
    receipt("swigUsdc", {
      swigWallet: swigWalletAddress.toBase58(),
      ata: swigAta.toBase58(),
      balanceAtomic: swigBal < 0n ? "ATA_MISSING" : swigBal.toString(),
    });

    // Overcommit headroom: register_session_key requires
    //   Σ(live sibling caps) + new cap + outstanding_locked ≤ ata.amount.
    // Sum the live caps; outstanding_locked is expected 0 on this dedicated
    // vault (a violation surfaces as SessionWouldOvercommitVault in test 1).
    const pop = await fetchVaultSessionAccounts(conn, vaultPda);
    const liveCaps = pop
      .filter((s) => isSessionLive(s))
      .reduce((sum, s) => sum + s.session.maxAmount, 0n);
    receipt("liveSessions", {
      count: pop.length,
      liveCapSumAtomic: liveCaps.toString(),
    });
    const balance = swigBal < 0n ? 0n : swigBal;
    const headroom = balance > liveCaps ? balance - liveCaps : 0n;
    if (headroom < MIN_SWIG_USDC) {
      throw new Error(
        `FUND THE TEST VAULT FIRST: swig USDC ATA ${swigAta.toBase58()} ` +
          `(owner = swig wallet ${swigWalletAddress.toBase58()}, off-curve; ` +
          `create the ATA if missing) holds ${balance} atomic with ` +
          `${liveCaps} committed to live sessions — headroom ${headroom} < ` +
          `${MIN_SWIG_USDC} atomic ($0.02) required. Send ≥ ` +
          `${MIN_SWIG_USDC - headroom} atomic USDC there, then re-run.`,
      );
    }
    cap = headroom < CAP_TARGET ? headroom : CAP_TARGET;
    expect(cap >= VOUCHER_AMOUNT, "cap must cover the $0.01 voucher").to.equal(true);
    receipt("sessionCapAtomic", cap.toString());

    // Revenue ATA: pre-existing, owned by the revenue wallet, USDC mint.
    const rev = await getAccount(conn, REVENUE_ATA);
    expect(rev.owner.toBase58(), "revenue ATA owner").to.equal(REVENUE_WALLET.toBase58());
    expect(rev.mint.toBase58(), "revenue ATA mint").to.equal(USDC_MAINNET.toBase58());
    receipt("revenueAta", { address: REVENUE_ATA.toBase58(), balanceAtomic: rev.amount.toString() });

    preflightOk = true;
    if (DRY) {
      console.log("\n    CANARY_DRY=1 — preconditions PASSED; tests 1+ will skip (no spend).\n");
    }
  });

  it("1. register a fresh session (local passkey ceremony) + pre-create seller ATA", async function () {
    if (!gate(this)) return;
    this.timeout(180_000);

    // Seller ATA first — the settle route does NOT create ATAs.
    sellerAta = getAssociatedTokenAddressSync(USDC_MAINNET, seller.publicKey);
    const ataSig = await sendSigned(
      conn,
      [
        createAssociatedTokenAccountIdempotentInstruction(
          payer.publicKey,
          sellerAta,
          seller.publicKey,
          USDC_MAINNET,
        ),
      ],
      [payer],
    );
    receipt("sellerAtaCreateTx", ataSig);
    receipt("seller", { wallet: seller.publicKey.toBase58(), ata: sellerAta.toBase58() });
    receipt("sessionPubkey", session.publicKey.toBase58());

    // Register through the same SDK surfaces prove-sdk-v6 proves: fresh
    // sibling discovery → 188-byte message → passkey ceremony → builder.
    const sessionPubkey = session.publicKey.toBytes();
    const expiresAt = BigInt(Math.floor(Date.now() / 1000)) + SESSION_TTL_S;
    const nonce = 1; // fresh random counterparty ⇒ brand-new session PDA
    const siblings = sessionPdasOf(await fetchVaultSessionAccounts(conn, vaultPda));

    const msg = sessionRegisterMessage({
      programId: DEXTER_VAULT_PROGRAM_ID,
      vaultPda,
      sessionPubkey,
      maxAmount: cap,
      expiresAt,
      allowedCounterparty: seller.publicKey,
      nonce,
      maxRevolvingCapacity: cap,
    });
    const signed = signOperationWithPasskey(passkey, msg);
    const precompileIx = buildSecp256r1VerifyInstruction(
      passkey.publicKey,
      signed.signature,
      signed.precompileMessage,
    );
    const registerIx = buildRegisterSessionKeyInstruction({
      vaultPda,
      sessionPubkey,
      maxAmount: cap,
      expiresAt,
      allowedCounterparty: seller.publicKey,
      nonce,
      maxRevolvingCapacity: cap,
      swigAddress,
      vaultUsdcAta: swigAta,
      payer: payer.publicKey,
      siblingSessionPdas: siblings,
      clientDataJSON: signed.clientDataJSON,
      authenticatorData: signed.authenticatorData,
    });
    const sig = await sendSigned(conn, [precompileIx, registerIx], [payer]);
    receipt("registerTx", sig);

    // Read-your-writes: content-aware wait (REPLACE-safe, replica-lag-safe).
    const state = await waitForSession(conn, vaultPda, seller.publicKey, {
      expectedSessionPubkey: sessionPubkey,
      timeoutMs: 60_000,
    });
    expect(state.session.spent).to.equal(0n);
    expect(state.session.maxAmount).to.equal(cap);
    receipt("sessionRegistered", {
      sessionPda: state.address,
      maxAmount: state.session.maxAmount.toString(),
      expiresAt: state.session.expiresAt,
      nonce: state.session.nonce,
    });
  });

  it("2. sign ONE cumulative voucher: exactly 10,000 atomic ($0.01), sequence 1", async function () {
    if (!gate(this)) return;
    channelId = crypto.randomBytes(32);
    const voucher = buildVoucherMessage(channelId, cumulative, 1);
    sessionSignature = await new NodeEd25519Signer(session.secretKey).sign(voucher);
    receipt("voucher", {
      channelIdBase64: channelId.toString("base64"),
      cumulativeAmount: cumulative.toString(),
      sequenceNumber: 1,
    });
  });

  it("3. capture balances BEFORE: seller (0), revenue (actual), swig", async function () {
    if (!gate(this)) return;
    this.timeout(60_000);
    sellerBefore = await getAccount(conn, sellerAta).then((a) => a.amount);
    revenueBefore = await getAccount(conn, REVENUE_ATA).then((a) => a.amount);
    swigBefore = await getAccount(conn, swigAta).then((a) => a.amount);
    expect(sellerBefore, "fresh seller ATA must start at 0").to.equal(0n);
    receipt("balancesBefore", {
      sellerAtomic: sellerBefore.toString(),
      revenueAtomic: revenueBefore.toString(),
      swigAtomic: swigBefore.toString(),
    });
  });

  it("4. settle THROUGH the LIVE facilitator — response fee invariants hold", async function () {
    if (!gate(this)) return;
    this.timeout(180_000);

    // Rebuild the exact 188-byte registration from LIVE on-chain values —
    // the route parses vault (offset 64) + counterparty (offset 144) from it.
    const fresh = await fetchSessionAccount(conn, vaultPda, seller.publicKey);
    expect(fresh, "session vanished before settle").to.not.equal(null);
    const registration = sessionRegisterMessage({
      programId: DEXTER_VAULT_PROGRAM_ID,
      vaultPda,
      sessionPubkey: fresh!.session.sessionPubkey,
      maxAmount: fresh!.session.maxAmount,
      expiresAt: BigInt(fresh!.session.expiresAt),
      allowedCounterparty: seller.publicKey,
      nonce: fresh!.session.nonce,
      maxRevolvingCapacity: fresh!.session.maxRevolvingCapacity,
    });

    const res = await fetch(`${FACILITATOR_URL}/tab/settle`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        network: SOLANA_MAINNET_CAIP2,
        channelId: channelId.toString("base64"),
        cumulativeAmount: cumulative.toString(),
        sequenceNumber: 1,
        sessionPublicKey: session.publicKey.toBase58(),
        sessionSignature: Buffer.from(sessionSignature).toString("base64"),
        sessionRegistration: Buffer.from(registration).toString("base64"),
      }),
    });
    const body: any = await res.json();
    receipt("settleHttp", { status: res.status, body });
    expect(res.status, JSON.stringify(body)).to.equal(200);
    expect(body.settleTx).to.be.a("string");
    settleTx = body.settleTx;

    // THE RESPONSE INVARIANTS (bigint math, no Number coercion):
    expect(body.grossAmount, "grossAmount").to.equal(VOUCHER_AMOUNT.toString());
    gross = BigInt(body.grossAmount);
    fee = BigInt(body.feeAmount);
    net = BigInt(body.netAmount);
    expect(fee > 0n, `feeAmount must be > 0 (fee split ON) — got ${body.feeAmount}`).to.equal(true);
    expect(body.netAmount, "netAmount = gross − fee").to.equal((VOUCHER_AMOUNT - fee).toString());
    expect(body.transferAmount, "transferAmount (seller payout) must equal netAmount").to.equal(body.netAmount);
    expect(gross === net + fee, "gross = net + fee (bigint)").to.equal(true);
    receipt("feeSplitResponse", {
      grossAmount: gross.toString(),
      feeAmount: fee.toString(),
      netAmount: net.toString(),
      settleTx,
    });
  });

  it("5. THE PROOF: both deltas land on-chain, both transfers in ONE tx", async function () {
    if (!gate(this)) return;
    this.timeout(180_000);

    // poll-is-the-assertion: seller delta === net AND revenue delta === fee.
    const deadline = Date.now() + 60_000;
    let sellerDelta = -1n;
    let revenueDelta = -1n;
    for (;;) {
      const sellerNow = await getAccount(conn, sellerAta).then((a) => a.amount);
      const revenueNow = await getAccount(conn, REVENUE_ATA).then((a) => a.amount);
      sellerDelta = sellerNow - sellerBefore;
      revenueDelta = revenueNow - revenueBefore;
      if (sellerDelta === net && revenueDelta === fee) break;
      if (Date.now() > deadline) break;
      await sleep(2_000);
    }
    receipt("onChainDeltas", {
      sellerDeltaAtomic: sellerDelta.toString(),
      revenueDeltaAtomic: revenueDelta.toString(),
    });
    expect(sellerDelta, "seller ATA delta must equal netAmount").to.equal(net);
    expect(revenueDelta, "revenue ATA delta must equal feeAmount").to.equal(fee);

    // The buyer side: swig paid exactly gross (net + fee out of ONE source).
    const swigAfter = await getAccount(conn, swigAta).then((a) => a.amount);
    receipt("swigDeltaAtomic", (swigBefore - swigAfter).toString());
    expect(swigBefore - swigAfter, "swig must be debited exactly gross").to.equal(gross);

    // The session odometer advanced.
    const after = await fetchSessionAccount(conn, vaultPda, seller.publicKey);
    expect(after!.session.spent).to.equal(cumulative);

    // BOTH TransferChecked in the SAME transaction: fetch the settle tx and
    // walk innerInstructions (the Swig SignV2 CPIs to the token program).
    let parsed = null;
    const txDeadline = Date.now() + 60_000;
    while (!parsed && Date.now() < txDeadline) {
      parsed = await conn.getParsedTransaction(settleTx, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
      });
      if (!parsed) await sleep(2_000);
    }
    expect(parsed, `settle tx ${settleTx} not fetchable`).to.not.equal(null);
    expect(parsed!.meta?.err ?? null, "settle tx must have succeeded").to.equal(null);

    const tokenTransfers: Array<{ destination: string; amount: string; type: string }> = [];
    for (const group of parsed!.meta?.innerInstructions ?? []) {
      for (const ix of group.instructions) {
        const p: any = (ix as any).parsed;
        if (!p || (ix as any).program !== "spl-token") continue;
        if (p.type !== "transferChecked" && p.type !== "transfer") continue;
        tokenTransfers.push({
          destination: p.info.destination,
          amount: p.info.tokenAmount?.amount ?? p.info.amount,
          type: p.type,
        });
      }
    }
    receipt("settleTxInnerTransfers", tokenTransfers);
    const sellerLeg = tokenTransfers.find(
      (t) => t.destination === sellerAta.toBase58() && BigInt(t.amount) === net,
    );
    const feeLeg = tokenTransfers.find(
      (t) => t.destination === REVENUE_ATA.toBase58() && BigInt(t.amount) === fee,
    );
    expect(sellerLeg, `seller transfer (${net} → ${sellerAta.toBase58()}) missing from tx ${settleTx}`).to.not.equal(undefined);
    expect(feeLeg, `fee transfer (${fee} → ${REVENUE_ATA.toBase58()}) missing from tx ${settleTx}`).to.not.equal(undefined);
    console.log(
      `    ✓ ONE tx ${settleTx}: seller ${net} + revenue ${fee} — the deployed Swig executed BOTH inner transfers`,
    );
  });

  it("6. fee recompute sanity (bounds, not exact — flat term isn't observable)", function () {
    if (!gate(this)) return;
    // fee = max(flat, gross × bps/10_000) with bps=100 ⇒ fee ≥ 1% of 10,000 = 100.
    // flat is capped at 250,000 atomic; the route rejects fee ≥ gross, so a
    // 200 settle already proved fee < gross — assert all bounds anyway.
    expect(fee >= 1n, "fee ≥ 1").to.equal(true);
    expect(fee >= 100n, "fee ≥ bps floor (1% of 10,000)").to.equal(true);
    expect(fee < gross, "fee < gross (seller nets > 0)").to.equal(true);
    const ceiling = 250_000n > gross ? 250_000n : gross;
    expect(fee <= ceiling, "fee ≤ max(flat ceiling, gross)").to.equal(true);
    receipt("feeBounds", { fee: fee.toString(), bpsFloor: "100", flatCeiling: "250000" });
  });

  it("7. cleanup: revoke the session (no dangling grant on the test vault)", async function () {
    if (!gate(this)) return;
    this.timeout(180_000);
    // The revoke message embeds the session pubkey READ FROM THE PDA — the
    // same path prove-sdk-v6 proves.
    const live = await fetchSessionAccount(conn, vaultPda, seller.publicKey);
    expect(live).to.not.equal(null);
    const msg = sessionRevokeMessage({
      programId: DEXTER_VAULT_PROGRAM_ID,
      vaultPda,
      sessionPubkey: live!.session.sessionPubkey,
    });
    const signed = signOperationWithPasskey(passkey, msg);
    const precompileIx = buildSecp256r1VerifyInstruction(
      passkey.publicKey,
      signed.signature,
      signed.precompileMessage,
    );
    const revokeIx = buildRevokeSessionKeyInstruction({
      vaultPda,
      allowedCounterparty: seller.publicKey,
      clientDataJSON: signed.clientDataJSON,
      authenticatorData: signed.authenticatorData,
    });
    const sig = await sendSigned(conn, [precompileIx, revokeIx], [payer]);
    receipt("revokeTx", sig);

    const cleared = await waitForSession(conn, vaultPda, seller.publicKey, {
      cleared: true,
      timeoutMs: 60_000,
    });
    expect(cleared.version).to.equal(0);
    receipt("sessionCleared", true);
  });
});
