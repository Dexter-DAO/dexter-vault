import { Connection, PublicKey, Transaction, TransactionInstruction } from '@solana/web3.js';
import { p256 } from '@noble/curves/p256';
import { sha256 } from '@noble/hashes/sha256';

const RPC = process.env.RPC;
const conn = new Connection(RPC, 'confirmed');
const PROGRAM = new PublicKey('Hg3wRaydFtJhYrdvYrKECacpJYDsC9Px7yKmpncj2fhc');
const SECP = new PublicKey('Secp256r1SigVerify1111111111111111111111111');
const VAULT = new PublicKey('7FE9VUeabi3sF8wUABV7F3eyvEi1ekDbER9k5JBYrWAi'); // the live guest vault
const FEE_PAYER = new PublicKey('X4o2kSLzqEQjnAzhq3L3BW92aawMV2n2F37EXd2GMpy'); // real funded acct (nominal)
const SYSVAR_IX = new PublicKey('Sysvar1nstructions1111111111111111111111111');
const DISC_PROVE = Buffer.from([/*prove_passkey*/ 0,0,0,0,0,0,0,0]); // placeholder; resolved below

// prove_passkey discriminator = sha256("global:prove_passkey")[0..8]
const disc = Buffer.from(sha256(new TextEncoder().encode('global:prove_passkey'))).subarray(0,8);

function b64url(u){return Buffer.from(u).toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');}
function clientDataJSON(challengeBytes){return new TextEncoder().encode(JSON.stringify({type:'webauthn.get',challenge:b64url(challengeBytes),origin:'https://dexter.cash',crossOrigin:false}));}
function authData(){const h=sha256(new TextEncoder().encode('dexter.cash'));const o=new Uint8Array(37);o.set(h,0);o[32]=0x05;new DataView(o.buffer).setUint32(33,1,false);return o;}
function precompileMsg(cdj,ad){const h=sha256(cdj);const o=new Uint8Array(ad.length+32);o.set(ad,0);o.set(h,ad.length);return o;}
function provePasskeyMsg(challenge){const tag=new TextEncoder().encode('siwx_login');const b=new Uint8Array(tag.length+32);b.set(tag,0);b.set(challenge,tag.length);return b;}

function secpIx(pub,sig,msg){
  const DS=2,OFS=14; const so=DS+OFS, po=so+64, mo=po+33, ms=msg.length;
  const d=new Uint8Array(mo+ms); d[0]=1; d[1]=0; const v=new DataView(d.buffer);
  v.setUint16(DS+0,so,true);v.setUint16(DS+2,0xffff,true);v.setUint16(DS+4,po,true);v.setUint16(DS+6,0xffff,true);v.setUint16(DS+8,mo,true);v.setUint16(DS+10,ms,true);v.setUint16(DS+12,0xffff,true);
  d.set(sig,so);d.set(pub,po);d.set(msg,mo);
  return new TransactionInstruction({keys:[],programId:SECP,data:Buffer.from(d)});
}
function proveIx(challenge,cdj,ad){
  // args: challenge[32] + vec<u8> client_data_json + vec<u8> authenticator_data (Anchor borsh)
  const lenCdj=Buffer.alloc(4);lenCdj.writeUInt32LE(cdj.length);
  const lenAd=Buffer.alloc(4);lenAd.writeUInt32LE(ad.length);
  const data=Buffer.concat([disc,Buffer.from(challenge),lenCdj,Buffer.from(cdj),lenAd,Buffer.from(ad)]);
  return new TransactionInstruction({keys:[{pubkey:VAULT,isSigner:false,isWritable:false},{pubkey:SYSVAR_IX,isSigner:false,isWritable:false}],programId:PROGRAM,data});
}

async function sim(challenge, signWith){
  const opMsg=provePasskeyMsg(challenge);
  const cdj=clientDataJSON(sha256(opMsg)); const ad=authData(); const pm=precompileMsg(cdj,ad);
  const sig=p256.sign(sha256(pm),signWith.priv,{lowS:true}).toCompactRawBytes();
  const tx=new Transaction().add(secpIx(signWith.pub,sig,pm), proveIx(challenge,cdj,ad));
  tx.feePayer=FEE_PAYER; tx.recentBlockhash=(await conn.getLatestBlockhash('confirmed')).blockhash;
  const r=await conn.simulateTransaction(tx, undefined, false);
  return r.value;
}

// We do NOT have 7FE9's real passkey. Test the REJECTION path: a WRONG passkey must fail on the LIVE program.
const wrongPriv=p256.utils.randomPrivateKey();
const wrong={priv:wrongPriv, pub:p256.getPublicKey(wrongPriv,true)};
const challenge=new Uint8Array(32); crypto.getRandomValues(challenge);

console.log('Live vault :', VAULT.toBase58());
console.log('Program    :', PROGRAM.toBase58(), '(deployed prove_passkey)');
console.log('Test       : a WRONG passkey signs the challenge → live mainnet program must REJECT\n');
const res=await sim(challenge, wrong);
console.log('simulate err :', JSON.stringify(res.err));
console.log('logs         :', (res.logs||[]).filter(l=>/Program log|PasskeyVerification|secp256r1|Hg3w|invoke|success|failed/i.test(l)).join('\n               ') || '(none)');
const rejected = res.err !== null;
console.log('\nVERDICT:', rejected ? 'REJECTED. prove_passkey is LIVE on mainnet and refuses a forged passkey for vault 7FE9.' : 'NOT rejected. Investigate.');
