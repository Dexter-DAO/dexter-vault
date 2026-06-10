// Shared bootstrap helper for `register_session_key` tests.
//
// As of Task 8 (V0.3 Decision 1), `register_session_key` requires three
// additional accounts — vault_usdc_ata + swig + swig_wallet_address — and
// enforces the overcommit invariant against `vault_usdc_ata.amount`. That
// means every test that registers a session MUST first stand up:
//
//   1. a vault bound to a fresh passkey (born V6 — initialize_vault stamps
//      VAULT_VERSION_V6 directly since the born-broken fix)
//   2. a real Swig (role 0 manageAuthority + role 1 ProgramExec marker)
//   3. set_swig binding vault ↔ swig
//   4. a mint + a swig-wallet-owned source ATA, optionally funded
//
// This helper centralizes that bootstrap so individual test files don't each
// recreate the (subtle) ordering and replica-lag guards.
//
// The role-1 ProgramExec marker is configurable so callers that need the
// settle_tab_voucher marker (settle/lock tests) get it; callers that don't
// care (registration-only tests) get a vanilla ProgramExec.

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { DexterVault } from "../../target/types/dexter_vault";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  createMint,
  mintTo,
  getAccount,
} from "@solana/spl-token";
import {
  fetchSwig,
  findSwigPda,
  getCreateSwigInstruction,
  getAddAuthorityInstructions,
  getSwigWalletAddress,
} from "@swig-wallet/kit";
import {
  Actions,
  createEd25519AuthorityInfo,
  createProgramExecAuthorityInfo,
  SolInstruction,
} from "@swig-wallet/lib";
import { address as kitAddress } from "@solana/kit";
import { deriveSessionPda, siblingRemainingAccounts } from "./session";
import {
  generateP256Keypair,
  signOperationWithPasskey,
  buildSecp256r1VerifyInstruction,
  setSwigMessage,
  P256Keypair,
  pollUntilAccountExists,
  pollUntilAccount,
  createAtaIdempotentFinalized,
  sendAddAuthorityResilient,
  sendAndConfirmWithRetry,
  sendPrecompilePairResilient,
  sendCreateSwigResilient,
  makeRateLimitedKitRpc,
} from "./secp256r1";

// settle_tab_voucher's Anchor discriminator — the 8-byte instruction-data
// prefix the swig ProgramExec authority (role 1) validates as a marker.
export const SETTLE_TAB_VOUCHER_DISCRIMINATOR = new Uint8Array([
  173, 22, 98, 31, 110, 129, 59, 161,
]);

// V2 188-byte session registration domain + builder (matches
// register_session_key.rs::build_registration_message under V2 / 188 bytes).
const REGISTER_DOMAIN_V2 = (() => {
  const buf = new Uint8Array(32);
  buf.set(new TextEncoder().encode("OTS_SESSION_REGISTER_V2"), 0);
  return buf;
})();

export function sessionRegisterMessageV2(args: {
  programId: PublicKey;
  vaultPda: PublicKey;
  sessionPubkey: Uint8Array;
  maxAmount: bigint;
  expiresAt: bigint;
  allowedCounterparty: PublicKey;
  nonce: number;
  maxRevolvingCapacity: bigint;
}): Uint8Array {
  const buf = new Uint8Array(188);
  const view = new DataView(buf.buffer);
  let o = 0;
  buf.set(REGISTER_DOMAIN_V2, o);
  o += 32;
  buf.set(args.programId.toBytes(), o);
  o += 32;
  buf.set(args.vaultPda.toBytes(), o);
  o += 32;
  buf.set(args.sessionPubkey, o);
  o += 32;
  view.setBigUint64(o, args.maxAmount, true);
  o += 8;
  view.setBigInt64(o, args.expiresAt, true);
  o += 8;
  buf.set(args.allowedCounterparty.toBytes(), o);
  o += 32;
  view.setUint32(o, args.nonce >>> 0, true);
  o += 4;
  view.setBigUint64(o, args.maxRevolvingCapacity, true);
  o += 8;
  if (o !== 188) throw new Error(`V2 register message wrong length: ${o}`);
  return buf;
}

// Kit v2 → web3.js v1 instruction converter (same shape lock-voucher/
// revolving-meter use; kit's nested @solana/* type duplication forces this).
export function kitInstructionsToWeb3(
  kitInstructions: any[],
): TransactionInstruction[] {
  return kitInstructions.map((ix) => {
    const sol = SolInstruction.from(ix);
    const web3 = sol.toWeb3Instruction();
    return {
      programId: new PublicKey(web3.programId.toBase58()),
      keys: web3.keys.map((k: any) => ({
        pubkey: new PublicKey(k.pubkey.toBase58()),
        isSigner: k.isSigner,
        isWritable: k.isWritable,
      })),
      data: Buffer.from(web3.data),
    } as TransactionInstruction;
  });
}

/**
 * State produced by `bootstrapForRegister`: vault + passkey + the full
 * swig + ATA apparatus the new `register_session_key` gate requires.
 *
 * Caller then drives `registerSessionV2` (or repeated registrations after
 * intervening revoke / lock activity) against this state.
 */
export interface RegisterReadyVault {
  vaultPda: PublicKey;
  passkey: P256Keypair;
  swigAddress: PublicKey;
  swigWalletAddress: PublicKey;
  swigWalletAddrKit: ReturnType<typeof kitAddress>;
  mint: PublicKey;
  /** swig-wallet-owned source ATA — register reads its `amount` field. */
  sourceAta: PublicKey;
  /** Decimals on the test mint (USDC parity → 6). */
  decimals: number;
}

export interface BootstrapOpts {
  /** Funding amount for the swig wallet ATA, in 6-decimal token units.
   *  This is the live `vault_usdc_ata.amount` the overcommit gate reads. */
  usdcFundingAmount: bigint;
  /** Role-1 ProgramExec marker. Defaults to settle_tab_voucher (matches
   *  lock_voucher / settle tests). */
  programExecMarker?: Uint8Array;
  /** Optional existing mint to enroll this vault on. When omitted, a fresh
   *  6-decimal mint is created. Credit tests pass a SHARED mint so the
   *  financier and user transact in the SAME token — without this, repay/seize
   *  SignV2 transfers fail with the SPL token program's "Account not associated
   *  with this Mint" (0x3), because two vaults would otherwise hold ATAs on two
   *  different mints. Real credit is same-token (USDC); this mirrors that. */
  mint?: PublicKey;
  /** Target vault version after init. NOTE: initialize_vault now stamps fresh
   *  vaults V6 directly (the born-broken fix), so EVERY value of this option
   *  yields a V6 vault — the migrate helpers are version-aware and skip hops
   *  already satisfied (migrate_v4_to_v5 / migrate_v5_to_v6 only fire on
   *  genuine pre-fix V4/V5 accounts, which a fresh bootstrap never is). The
   *  option is kept so existing call sites compile unchanged; a fresh-V5 or
   *  fresh-V4 vault is NO LONGER CONSTRUCTIBLE through this path. */
  migrateTo?: 4 | 5 | 6;
}

/**
 * Provision a vault (born V6), stand up the real Swig (role 0 + role 1
 * ProgramExec), bind via `set_swig`, mint a USDC-parity token, create + fund
 * the swig-wallet-owned source ATA. After this returns,
 * `register_session_key` will have its three new accounts available and
 * `vault_usdc_ata.amount` set to `usdcFundingAmount`.
 */
export async function bootstrapForRegister(
  program: Program<DexterVault>,
  provider: anchor.AnchorProvider,
  opts: BootstrapOpts,
): Promise<RegisterReadyVault> {
  const connection = provider.connection;
  const wallet = (provider.wallet as anchor.Wallet).payer;
  const rpc = makeRateLimitedKitRpc(connection.rpcEndpoint);

  const identityClaim = new Uint8Array(32);
  crypto.getRandomValues(identityClaim);
  const passkey: P256Keypair = generateP256Keypair();
  const [vaultPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), Buffer.from(identityClaim.slice(0, 16))],
    program.programId,
  );

  // initialize_vault is idempotent against a transient drop (a re-send of a
  // never-included init lands identically; a re-send of an already-landed init
  // reverts cleanly and the trailing pollUntilAccountExists is the source of
  // truth either way). Build the ix and route through sendAndConfirmWithRetry so
  // a dropped send self-heals with a fresh blockhash; KEEP the existing poll.
  const initVaultIx = await program.methods
    .initializeVault({
      passkeyPubkey: Array.from(passkey.publicKey),
      coolingOffSeconds: 0,
      identityClaim: Array.from(identityClaim),
    })
    .accountsPartial({
      vault: vaultPda,
      payer: provider.wallet.publicKey,
      dexterAuthority: provider.wallet.publicKey,
      systemProgram: SystemProgram.programId,
    })
    .instruction();
  await sendAndConfirmWithRetry(provider, [initVaultIx]);
  await pollUntilAccountExists(connection, vaultPda);

  // ── Real Swig: role 0 bootstrap (manageAuthority) + role 1 ProgramExec
  //    with caller-chosen marker (defaults to settle_tab_voucher). ──────────
  const swigId = new Uint8Array(32);
  crypto.getRandomValues(swigId);
  const swigPdaKit = await findSwigPda(swigId);
  const swigAddress = new PublicKey(String(swigPdaKit));

  const bootstrapAuthority = createEd25519AuthorityInfo(
    Uint8Array.from(wallet.publicKey.toBytes()),
  );
  const bootstrapActions = Actions.set().manageAuthority().get();

  const vaultProgramIdBytes = Uint8Array.from(program.programId.toBytes());
  const marker = opts.programExecMarker ?? SETTLE_TAB_VOUCHER_DISCRIMINATOR;
  const vaultAuthority = createProgramExecAuthorityInfo(
    vaultProgramIdBytes,
    marker,
  );
  const vaultActions = Actions.set().all().get();

  const createSwigCtx = await getCreateSwigInstruction({
    payer: kitAddress(wallet.publicKey.toBase58()),
    id: swigId,
    actions: bootstrapActions,
    authorityInfo: bootstrapAuthority,
  });
  // swig CREATE is non-idempotent (fixed swigId): a blind resubmit of a
  // dropped-but-landed create would revert "already in use". Use check-then-skip
  // — on a transient drop, poll getAccountInfo for the swig address; resend only
  // if it truly never landed. Happy path = the original single-shot send.
  await sendCreateSwigResilient(
    provider,
    kitInstructionsToWeb3([createSwigCtx]),
    swigAddress,
  );

  const swigForAdd = await fetchSwig(
    rpc as any,
    kitAddress(swigAddress.toBase58()),
  );
  if (!swigForAdd) throw new Error("Swig not visible post-create");
  // Role count BEFORE the add — the add appends role 1 onto the fresh swig
  // (role 0 = bootstrap manageAuthority). Used by sendAddAuthorityResilient to
  // confirm the add actually landed (defeats a dropped-but-landed send).
  const rolesBefore: any[] =
    (swigForAdd as any).roles ?? (swigForAdd as any).authorities ?? [];
  const addAuthorityIxs = await getAddAuthorityInstructions(
    swigForAdd,
    0,
    vaultAuthority,
    vaultActions,
    { payer: kitAddress(wallet.publicKey.toBase58()) },
  );
  await sendAddAuthorityResilient(
    provider,
    kitInstructionsToWeb3(addAuthorityIxs),
    async () => {
      const s = await fetchSwig(rpc as any, kitAddress(swigAddress.toBase58()));
      const roles: any[] = (s as any)?.roles ?? (s as any)?.authorities ?? [];
      return roles.length;
    },
    rolesBefore.length + 1,
  );

  // ── set_swig — passkey signs, binding the vault to the real Swig. ────────
  const setSwigOp = setSwigMessage(swigAddress);
  const setSwigSigned = signOperationWithPasskey(passkey, setSwigOp);
  const setSwigPrecompile = buildSecp256r1VerifyInstruction(
    passkey.publicKey,
    setSwigSigned.signature,
    setSwigSigned.precompileMessage,
  );
  const setSwigVaultIx = await program.methods
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
  // [precompile, set_swig] pair — resilient send + poll the RESULT (vault's
  // swig_address now equals the bound swig). On a transient drop the poll
  // confirms whether the first send landed; a real revert on the first send
  // propagates. Precompile order preserved (precompile immediately before the
  // vault ix). Purely additive: happy path identical to the original send.
  await sendPrecompilePairResilient(
    provider,
    [setSwigPrecompile, setSwigVaultIx],
    async () => {
      const v: any = await program.account.vault.fetch(vaultPda);
      return v.swigAddress.equals(swigAddress);
    },
  );

  // ── Mint + funded swig-wallet ATA. ────────────────────────────────────────
  // Reuse a caller-supplied mint (credit tests share ONE mint across the
  // financier + user vaults so cross-vault SignV2 transfers don't hit the SPL
  // token program's mint-mismatch error). Otherwise mint a fresh 6-decimal one.
  const decimals = 6;
  let mint: PublicKey;
  if (opts.mint) {
    mint = opts.mint;
  } else {
    mint = await createMint(connection, wallet, wallet.publicKey, null, decimals);
    await pollUntilAccountExists(connection, mint);
  }

  const swigForWallet = await fetchSwig(
    rpc as any,
    kitAddress(swigAddress.toBase58()),
  );
  if (!swigForWallet) throw new Error("Swig not visible for wallet derivation");
  const swigWalletAddrKit = await getSwigWalletAddress(swigForWallet);
  const swigWalletAddress = new PublicKey(String(swigWalletAddrKit));

  const sourceAta = await createAtaIdempotentFinalized(
    provider,
    wallet,
    mint,
    swigWalletAddress,
    true /* allowOwnerOffCurve — swig wallet is a PDA */,
  );

  if (opts.usdcFundingAmount > 0n) {
    await mintTo(
      connection,
      wallet,
      mint,
      sourceAta,
      wallet,
      opts.usdcFundingAmount,
    );
    await pollUntilAccount(
      () => getAccount(connection, sourceAta, "finalized"),
      (acct) => acct.amount >= opts.usdcFundingAmount,
    );
  }

  // ── Optional version migration. initialize_vault stamps V6 directly now, so
  //    on a fresh bootstrap BOTH hops are version-aware no-ops (the helpers read
  //    the raw version byte and skip hops already satisfied). The walk is kept
  //    so this helper still works if it's ever pointed at a genuine pre-fix
  //    V4/V5 account. The migrate helpers live in ./credit; we import them at
  //    call-time (dynamic import) to avoid a static circular import (credit.ts
  //    imports from here).
  const migrateTo = opts.migrateTo ?? 4;
  if (migrateTo >= 5) {
    const { migrateVaultToV5, migrateVaultToV6 } = await import("./credit");
    await migrateVaultToV5(program, provider, vaultPda);
    if (migrateTo >= 6) {
      await migrateVaultToV6(program, provider, vaultPda);
    }
  }

  return {
    vaultPda,
    passkey,
    swigAddress,
    swigWalletAddress,
    swigWalletAddrKit,
    mint,
    sourceAta,
    decimals,
  };
}

/**
 * Build + submit a V2/188-byte session registration against a vault that has
 * already been bootstrapped (swig set, source ATA funded). Returns the
 * session keypair the caller can retain to sign vouchers.
 */
export interface RegisterSessionV2Opts {
  vaultPda: PublicKey;
  passkey: P256Keypair;
  /** The swig-wallet-owned source ATA — the gate reads its `amount`. */
  vaultUsdcAta: PublicKey;
  swigAddress: PublicKey;
  swigWalletAddress: PublicKey;
  sessionKeypair?: Keypair;
  maxAmount: bigint;
  maxRevolvingCapacity: bigint;
  allowedCounterparty?: PublicKey;
  expiresAt?: bigint;
  nonce?: number;
  /** V6 overcommit gate: the live + expired sibling SessionAccount PDAs to pass
   *  as remaining_accounts, in any order (siblingRemainingAccounts sorts them
   *  strict-ascending and marks expired ones writable for the on-chain sweep).
   *  Default `[]` — the single-session case needs no siblings. */
  siblings?: { pubkey: PublicKey; isExpired?: boolean }[];
}

export interface RegisteredSession {
  sessionKeypair: Keypair;
  signature: string;
  /** The per-counterparty session PDA this registration wrote (V6). Tests
   *  fetch `program.account.sessionAccount.fetch(sessionPda)` to assert. */
  sessionPda: PublicKey;
  /** V6: the counterparty this session was registered against (the default is
   *  a fresh random key when `opts.allowedCounterparty` is omitted). Callers
   *  that later drive settle/lock/revoke against this session need it to pass
   *  `allowedCounterparty` in the args + re-derive the session PDA seed. */
  allowedCounterparty: PublicKey;
}

export async function registerSessionV2(
  program: Program<DexterVault>,
  provider: anchor.AnchorProvider,
  opts: RegisterSessionV2Opts,
): Promise<RegisteredSession> {
  const sessionKeypair = opts.sessionKeypair ?? Keypair.generate();
  const sessionPubkey = sessionKeypair.publicKey.toBytes();
  const allowedCounterparty =
    opts.allowedCounterparty ?? Keypair.generate().publicKey;
  const expiresAt =
    opts.expiresAt ?? BigInt(Math.floor(Date.now() / 1000) + 3600);
  const nonce = opts.nonce ?? 1;

  // V6: the per-counterparty session PDA the handler init_if_needed-creates,
  // derived from [SESSION_SEED, vault, allowed_counterparty] (== on-chain seeds).
  const [sessionPda] = deriveSessionPda(
    program.programId,
    opts.vaultPda,
    allowedCounterparty,
  );

  const msg = sessionRegisterMessageV2({
    programId: program.programId,
    vaultPda: opts.vaultPda,
    sessionPubkey,
    maxAmount: opts.maxAmount,
    expiresAt,
    allowedCounterparty,
    nonce,
    maxRevolvingCapacity: opts.maxRevolvingCapacity,
  });
  const signed = signOperationWithPasskey(opts.passkey, msg);
  const precompileIx = buildSecp256r1VerifyInstruction(
    opts.passkey.publicKey,
    signed.signature,
    signed.precompileMessage,
  );
  const vaultIx = await program.methods
    .registerSessionKey({
      sessionPubkey: Array.from(sessionPubkey),
      maxAmount: new anchor.BN(opts.maxAmount.toString()),
      expiresAt: new anchor.BN(expiresAt.toString()),
      allowedCounterparty,
      nonce,
      maxRevolvingCapacity: new anchor.BN(opts.maxRevolvingCapacity.toString()),
      clientDataJson: Buffer.from(signed.clientDataJSON),
      authenticatorData: Buffer.from(signed.authenticatorData),
    })
    .accountsPartial({
      vault: opts.vaultPda,
      vaultUsdcAta: opts.vaultUsdcAta,
      swig: opts.swigAddress,
      swigWalletAddress: opts.swigWalletAddress,
      instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
      session: sessionPda,
      payer: provider.wallet.publicKey,
      systemProgram: SystemProgram.programId,
    })
    .remainingAccounts(siblingRemainingAccounts(opts.siblings ?? []))
    .instruction();
  // [precompile, register_session_key] pair — resilient send + poll the RESULT.
  // V6 REMOVED vault.activeSession — the registration now lives in the
  // per-counterparty SessionAccount PDA. Poll THAT: fetch the session PDA and
  // confirm its `session.sessionPubkey` matches the registered pubkey AND its
  // `version != 0` (0 = never-touched / cleared-by-revoke). On a transient drop
  // the poll confirms whether the first send landed (a blind resubmit would
  // revert on the nonce/duplicate); a real revert on the first send propagates.
  // Precompile order preserved. If the helper self-heals via poll it returns no
  // signature — preserve the API by falling back to the empty string in that
  // (rare) path; the registration IS confirmed present by the poll.
  const sig = await sendPrecompilePairResilient(
    provider,
    [precompileIx, vaultIx],
    async () => {
      const s: any = await program.account.sessionAccount
        .fetch(sessionPda)
        .catch(() => null);
      if (!s || s.version === 0) return false;
      const onchain: number[] = s.session.sessionPubkey;
      return (
        onchain.length === sessionPubkey.length &&
        onchain.every((b, i) => b === sessionPubkey[i])
      );
    },
  );
  const signature = sig ?? "";
  // CONFIRM-VISIBILITY CONTRACT: sendPrecompilePairResilient only runs its result
  // poll on the transient-drop self-heal path; on the happy path (first send
  // confirms) it returns WITHOUT polling. But on a lean RPC plan the just-created
  // SessionAccount PDA may not be visible on the read replica yet — a caller that
  // immediately `program.account.sessionAccount.fetch(sessionPda)` then hits
  // "Account does not exist". So we ALWAYS wait here until the session PDA is
  // visible and written (version != 0) before returning. Every caller inherits a
  // read-your-writes guarantee; no per-call-site polling needed.
  // Wait until THIS registration's CONTENT is visible (not just that the account
  // exists): match the on-chain session_pubkey to the one we just registered. On a
  // REPLACE (re-register same counterparty) the account already has version!=0 with
  // the OLD scope, so a version-only poll would pass on stale data before the
  // overwrite lands; the fresh-per-register session_pubkey is the reliable
  // new-content signal for BOTH new and replace paths.
  await pollUntilAccount(
    () => program.account.sessionAccount.fetch(sessionPda),
    (s: any) => {
      if (s.version === 0) return false; // not yet written / cleared
      const onchain: number[] = s.session.sessionPubkey;
      return (
        onchain.length === sessionPubkey.length &&
        onchain.every((b, i) => b === sessionPubkey[i])
      );
    },
  );
  return { sessionKeypair, signature, sessionPda, allowedCounterparty };
}
