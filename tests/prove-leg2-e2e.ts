/**
 * PROVE: Connect-a-Tab LEG 2 end-to-end on mainnet (gated; Branch in the loop).
 *
 *   request → (Branch taps the REAL consent page) → sponsored register →
 *   openTab (dexter_authority arms it) → settle THROUGH the facilitator's
 *   HTTP /tab/settle route in REAL USDC → revoke (Branch, one tap, from the
 *   /tab list) — receipts kept.
 *
 * THE HUMAN STEPS ARE THE POINT: consent and revoke run on the production
 * dexter-fe against the production dexter-api sponsor endpoints — the script
 * plays only the third-party app + buyer agent (custody mode ii: it supplies
 * sessionPubkey in the blob and holds the secret, so it can sign vouchers).
 *
 * RUN (Branch GO; orchestrator only):
 *   cd dexter-vault && \
 *   HELIUS_RPC_URL="https://mainnet.helius-rpc.com/?api-key=<key>" \
 *   PROOF_VAULT_PDA="<Branch's production vault PDA>" \
 *   npx ts-mocha -p ./tsconfig.json -t 1800000 tests/prove-leg2-e2e.ts
 *
 * Optional env: FACILITATOR_URL (default https://x402.dexter.cash),
 *               CONSENT_ORIGIN (default https://dexter.cash).
 *
 * PRE-CONDITIONS (orchestrator checklist, enforced by the early tests):
 *   1. the proof seller is on the invite list (admin route, Task B6);
 *   2. the swig wallet ATA holds >= CAP real USDC;
 *   3. dexter-api + dexter-fe deployed with Phases B + C.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { expect } from "chai";
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  Transaction,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  getAccount,
} from "@solana/spl-token";
import { fetchSwig, getSwigWalletAddress } from "@swig-wallet/kit";
import { createSolanaRpc, address as kitAddress } from "@solana/kit";

import { requestSpendGrant, encodeSpendGrantRequest } from "@dexterai/vault/grant";
import { openTab } from "@dexterai/vault/tab";
import { sessionRegisterMessage, buildVoucherMessage } from "@dexterai/vault/messages";
import { fetchSessionAccount, waitForSession } from "@dexterai/vault/session";
import { readVaultFull } from "@dexterai/vault/reader";
import { DEXTER_VAULT_PROGRAM_ID } from "@dexterai/vault/constants";
import { NodeEd25519Signer } from "@dexterai/vault/signers/node";

const RPC = process.env.HELIUS_RPC_URL ?? "";
const VAULT_PDA_STR = process.env.PROOF_VAULT_PDA ?? "";
const FACILITATOR_URL = process.env.FACILITATOR_URL ?? "https://x402.dexter.cash";
const CONSENT_ORIGIN = process.env.CONSENT_ORIGIN ?? "https://dexter.cash";
const API_ORIGIN = process.env.API_ORIGIN ?? "https://api.dexter.cash";
const USDC_MAINNET = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const SOLANA_MAINNET_CAIP2 = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";

const CAP = 500_000n;          // $0.50 proposed cap
const OPEN_AMOUNT = 200_000n;  // $0.20 armed
const SETTLE_DELTA = 100_000n; // $0.10 settled through the facilitator

const KEYS_FILE = path.join(__dirname, ".leg2-proof-keys.json");
const RECEIPTS_FILE = path.join(__dirname, `.leg2-proof-receipts-${Date.now()}.json`);

function loadKeypair(p: string): Keypair {
  const resolved = p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p;
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(resolved, "utf8"))));
}

/** Persisted app-side keys: the REPLACE run must reuse the same SELLER.
 *  The SESSION keypair is deliberately FRESH per run — replace is keyed by
 *  (vault, counterparty), so persisting it buys nothing, and a stale live
 *  session carrying the same pubkey would make test 3's content-aware wait
 *  resolve instantly BEFORE Branch taps (the aborted-prior-run trap). */
function loadOrCreateProofKeys(): { seller: Keypair; session: Keypair } {
  const session = Keypair.generate();
  if (fs.existsSync(KEYS_FILE)) {
    const raw = JSON.parse(fs.readFileSync(KEYS_FILE, "utf8"));
    return { seller: Keypair.fromSecretKey(Uint8Array.from(raw.seller)), session };
  }
  const seller = Keypair.generate();
  fs.writeFileSync(
    KEYS_FILE,
    JSON.stringify({ seller: Array.from(seller.secretKey) }),
    { mode: 0o600 },
  );
  return { seller, session };
}

const receipts: Record<string, unknown> = {};
function receipt(key: string, value: unknown) {
  receipts[key] = value;
  console.log(`[receipt] ${key}:`, value);
  fs.writeFileSync(RECEIPTS_FILE, JSON.stringify(receipts, null, 2));
}

async function sendSigned(conn: Connection, ixs: Parameters<Transaction["add"]>, signers: Keypair[]): Promise<string> {
  const tx = new Transaction().add(...ixs);
  tx.feePayer = signers[0].publicKey;
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  tx.sign(...signers);
  const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false });
  const c = await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
  if (c.value.err) throw new Error(`tx failed on-chain: ${JSON.stringify(c.value.err)}`);
  return sig;
}

describe("PROVE: leg-2 spend grant end-to-end (mainnet, human in the loop)", function () {
  let conn: Connection;
  let vaultPda: PublicKey;
  let payer: Keypair;   // X4o2… — harness fees + seller ATA rent
  let master: Keypair;  // 3SWJ… — dexter_authority for openTab
  let seller: Keypair;
  let session: Keypair;
  let swigWalletAddress: PublicKey;
  let sellerAta: PublicKey;
  let grantedMaxAmount = CAP;   // may be SHORTENED by Branch on the consent page
  let spentBefore = 0n;

  it("0. preconditions: env, keys, vault authority, swig USDC funding", async function () {
    this.timeout(120_000);
    expect(RPC, "HELIUS_RPC_URL is required (Helius only — hard constraint)").to.match(/helius/);
    expect(VAULT_PDA_STR, "PROOF_VAULT_PDA is required").to.have.length.greaterThan(30);
    conn = new Connection(RPC, "confirmed");
    vaultPda = new PublicKey(VAULT_PDA_STR);
    payer = loadKeypair("~/.config/solana/dexter-vault/upgrade-authority.json");
    master = loadKeypair("~/.config/solana/dexter-vault/api-session-master.json");
    ({ seller, session } = loadOrCreateProofKeys());
    console.log("proof seller (counterparty):", seller.publicKey.toBase58());
    console.log("buyer-agent session pubkey :", session.publicKey.toBase58());

    const vault = await readVaultFull(conn, vaultPda);
    expect(vault.exists, "vault must exist on-chain").to.equal(true);
    // The facilitator 403s (dexter_authority_mismatch) unless the vault's
    // authority IS the session master — production-enrolled vaults qualify.
    expect(vault.dexterAuthority).to.equal(master.publicKey.toBase58());
    expect(vault.swigAddress).to.be.a("string");

    const rpc: any = createSolanaRpc(RPC);
    const swig = await fetchSwig(rpc, kitAddress(vault.swigAddress!));
    swigWalletAddress = new PublicKey(String(await getSwigWalletAddress(swig)));
    const swigAta = getAssociatedTokenAddressSync(USDC_MAINNET, swigWalletAddress, true);
    const bal = await getAccount(conn, swigAta).then((a) => a.amount).catch(() => 0n);
    receipt("swigUsdcBefore", bal.toString());
    expect(bal >= CAP, `fund the swig ATA with >= $${Number(CAP) / 1e6} USDC BEFORE granting (overcommit gate)`).to.equal(true);

    // Precondition 1 enforced HERE, not 15 minutes into Branch's tap: the
    // proof seller must be on the invite list (admin route, Task B6).
    const inviteRes = await fetch(
      `${API_ORIGIN}/api/passkey-vault/grants/invite-status?counterparty=${seller.publicKey.toBase58()}`,
    );
    const invite = (await inviteRes.json()) as { invited?: boolean };
    receipt("inviteStatus", invite);
    expect(
      invite.invited,
      `seed the proof seller on the invite list first: POST ${API_ORIGIN}/internal/admin/vault-grant-sponsors`,
    ).to.equal(true);

    // RUN-SHEET GUARD: a wrong PROOF_VAULT_PDA is the least-discoverable
    // failure — the consent page registers against Branch's IDENTITY vault
    // (it never sees this env var), the harness times out in test 3, and a
    // live grant is stranded on the real vault. Confirm before the taps:
    // PROOF_VAULT_PDA must equal the vault dexter.cash/tab shows for the
    // identity Branch will approve with.
    console.log("watching vault:", vaultPda.toBase58(), "— MUST be the vault Branch's /tab page shows");
  });

  it("1. pre-create the seller USDC ATA (the settle route does NOT create it)", async function () {
    this.timeout(120_000);
    sellerAta = getAssociatedTokenAddressSync(USDC_MAINNET, seller.publicKey);
    const ix = createAssociatedTokenAccountIdempotentInstruction(
      payer.publicKey, sellerAta, seller.publicKey, USDC_MAINNET,
    );
    const sig = await sendSigned(conn, [ix] as any, [payer]);
    receipt("sellerAtaCreateTx", sig);
    receipt("sellerAta", sellerAta.toBase58());
  });

  it("2. request: build the blob (custody mode ii) and print the REAL consent URL", async function () {
    const existing = await fetchSessionAccount(conn, vaultPda, seller.publicKey);
    receipt("priorSessionLive", existing !== null && existing.version !== 0);
    const blob = requestSpendGrant({
      app: { name: "Leg-2 Proof App", domain: "proof.dexter.cash" },
      counterparty: seller.publicKey.toBase58(),
      capAtomic: CAP.toString(),
      expiresAtUnix: Math.floor(Date.now() / 1000) + 7 * 86400,
      sessionPubkey: session.publicKey.toBase58(),
      requestId: `leg2-proof-${Date.now()}`,
    });
    const url = `${CONSENT_ORIGIN}/grant?req=${encodeSpendGrantRequest(blob)}`;
    receipt("consentUrl", url);
    console.log("\n=== BRANCH: open this on the production consent page and approve ===\n");
    console.log(url, "\n");
  });

  it("3. consent lands: wait for the sponsored register (Branch taps now)", async function () {
    this.timeout(900_000); // 15 min for the human tap
    const state = await waitForSession(conn, vaultPda, seller.publicKey, {
      expectedSessionPubkey: session.publicKey.toBytes(),
      timeoutMs: 880_000,
      pollIntervalMs: 5_000,
    });
    grantedMaxAmount = state.session.maxAmount; // honors a shorten edit
    spentBefore = state.session.spent;          // 0 on fresh AND on replace (meters reset)
    receipt("grant", {
      sessionPda: state.address,
      maxAmount: state.session.maxAmount.toString(),
      expiresAt: state.session.expiresAt,
      nonce: state.session.nonce,
      spent: state.session.spent.toString(),
      maxRevolvingCapacity: state.session.maxRevolvingCapacity.toString(),
    });
    expect(state.session.spent).to.equal(0n); // fresh OR replaced-with-reset
  });

  it("4. openTab: dexter_authority arms the tab (settle_voucher increment)", async function () {
    this.timeout(180_000);
    const arm = OPEN_AMOUNT < grantedMaxAmount ? OPEN_AMOUNT : grantedMaxAmount;
    const ixs = await openTab({
      vaultPda,
      amount: arm,
      dexterAuthority: master.publicKey,
      allowedCounterparty: seller.publicKey,
    });
    const sig = await sendSigned(
      conn,
      [ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }), ...ixs] as any,
      [payer, master],
    );
    receipt("openTabTx", sig);
    const after = await fetchSessionAccount(conn, vaultPda, seller.publicKey);
    receipt("outstandingAfterOpen", after!.session.currentOutstanding.toString());
    expect(after!.session.currentOutstanding).to.equal(arm);
  });

  it("5. settle THROUGH the facilitator HTTP route, real USDC", async function () {
    this.timeout(180_000);
    const fresh = await fetchSessionAccount(conn, vaultPda, seller.publicKey);
    const delta = SETTLE_DELTA <= fresh!.session.currentOutstanding
      ? SETTLE_DELTA
      : fresh!.session.currentOutstanding;
    const cumulative = fresh!.session.spent + delta;
    const channelId = crypto.randomBytes(32);
    const voucher = buildVoucherMessage(channelId, cumulative, 1);
    const signer = new NodeEd25519Signer(session.secretKey);
    const sessionSignature = await signer.sign(voucher);
    // Rebuild the exact 188-byte registration from LIVE on-chain values —
    // the route parses vault (offset 64) + counterparty (offset 144) from it.
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
    const sellerBefore = await getAccount(conn, sellerAta).then((a) => a.amount).catch(() => 0n);

    const res = await fetch(`${FACILITATOR_URL}/tab/settle`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        network: SOLANA_MAINNET_CAIP2,
        channelId: Buffer.from(channelId).toString("base64"),
        cumulativeAmount: cumulative.toString(),
        sequenceNumber: 1,
        sessionPublicKey: session.publicKey.toBase58(),
        sessionSignature: Buffer.from(sessionSignature).toString("base64"),
        sessionRegistration: Buffer.from(registration).toString("base64"),
      }),
    });
    const body = await res.json();
    receipt("settleHttp", { status: res.status, body });
    expect(res.status, JSON.stringify(body)).to.equal(200);
    expect(body.settleTx).to.be.a("string");
    expect(String(body.transferAmount)).to.equal(delta.toString());

    // poll-is-the-assertion: the meter must advance and outstanding release.
    const deadline = Date.now() + 60_000;
    let after = await fetchSessionAccount(conn, vaultPda, seller.publicKey);
    while (after!.session.spent !== cumulative && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 2_000));
      after = await fetchSessionAccount(conn, vaultPda, seller.publicKey);
    }
    expect(after!.session.spent).to.equal(cumulative);
    // Same replica-flap class: poll the seller balance, don't one-shot it.
    let sellerAfter = await getAccount(conn, sellerAta).then((a) => a.amount);
    const balDeadline = Date.now() + 30_000;
    while (sellerAfter - sellerBefore !== delta && Date.now() < balDeadline) {
      await new Promise((r) => setTimeout(r, 2_000));
      sellerAfter = await getAccount(conn, sellerAta).then((a) => a.amount);
    }
    receipt("sellerUsdcDelta", (sellerAfter - sellerBefore).toString());
    expect(sellerAfter - sellerBefore).to.equal(delta);
    receipt("meterAfterSettle", {
      spent: after!.session.spent.toString(),
      currentOutstanding: after!.session.currentOutstanding.toString(),
    });
  });

  it("6. revoke: Branch taps Revoke on /tab — wait for cleared", async function () {
    this.timeout(900_000);
    const before = await readVaultFull(conn, vaultPda);
    console.log("\n=== BRANCH: open https://dexter.cash/tab and revoke 'Leg-2 Proof App' ===\n");
    const cleared = await waitForSession(conn, vaultPda, seller.publicKey, {
      cleared: true,
      timeoutMs: 880_000,
      pollIntervalMs: 5_000,
    });
    expect(cleared.version).to.equal(0);
    // THE POLL IS THE ASSERTION (d542e48 lesson): a one-shot vault re-read
    // after the session poll can hit a lagging replica and fail a fully
    // successful run at the very last line — poll the decrement instead.
    const countDeadline = Date.now() + 60_000;
    let after = await readVaultFull(conn, vaultPda);
    while (after.liveSessionCount !== before.liveSessionCount - 1 && Date.now() < countDeadline) {
      await new Promise((r) => setTimeout(r, 2_000));
      after = await readVaultFull(conn, vaultPda);
    }
    receipt("liveSessionCount", { before: before.liveSessionCount, after: after.liveSessionCount });
    expect(after.liveSessionCount).to.equal(before.liveSessionCount - 1);
    console.log("\nALL RECEIPTS:", JSON.stringify(receipts, null, 2));
  });
});
