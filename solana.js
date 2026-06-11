// Solana integration: token-holding verification, pump.fun creator fee claiming, payouts.
// The private key lives ONLY in .env (gitignored).
require('dotenv').config();

let web3 = null;
let bs58decode = null;
let available = true;
try {
  web3 = require('@solana/web3.js');
  const bs58 = require('bs58');
  bs58decode = bs58.decode || (bs58.default && bs58.default.decode);
  // guard against an outdated @solana/web3.js (e.g. 0.0.x pulled in by `npm audit fix --force`)
  if (!web3.Connection || !web3.VersionedTransaction || !web3.Keypair) {
    throw new Error('@solana/web3.js is too old - run: npm install @solana/web3.js@^1.98.4');
  }
} catch (e) {
  available = false;
  console.warn('[solana] on-chain features disabled:', e.message);
}

const RPC_URL = process.env.RPC_URL || 'https://api.mainnet-beta.solana.com';
const TOKEN_MINT = process.env.TOKEN_MINT || 'CrEt5UA41mNBxz82kkuvMgSVqQmDC6jvVLoKg6ekpump';
const HOLD_REQUIREMENT = Number(process.env.HOLD_REQUIREMENT || 50000);
const STRICT_HOLD = process.env.STRICT_HOLD === 'true';
const DISTRIBUTE_ONCHAIN = process.env.DISTRIBUTE_ONCHAIN === 'true';
const MIN_PAYOUT_SOL = Number(process.env.MIN_PAYOUT_SOL || 0.01);

let conn = null;
let keypair = null;

function init() {
  if (!available) return false;
  if (!conn) conn = new web3.Connection(RPC_URL, 'confirmed');
  if (!keypair && process.env.PRIVATE_KEY) {
    try {
      keypair = web3.Keypair.fromSecretKey(bs58decode(process.env.PRIVATE_KEY.trim()));
      console.log('[solana] creator wallet:', keypair.publicKey.toBase58());
    } catch (e) {
      console.error('[solana] invalid PRIVATE_KEY in .env:', e.message);
    }
  }
  return true;
}

// Total $ARENA (UI amount) held by a wallet
async function tokenBalance(wallet) {
  init();
  const res = await conn.getParsedTokenAccountsByOwner(
    new web3.PublicKey(wallet),
    { mint: new web3.PublicKey(TOKEN_MINT) }
  );
  return res.value.reduce(
    (sum, acc) => sum + (acc.account.data.parsed.info.tokenAmount.uiAmount || 0), 0
  );
}

// Claim pump.fun creator fees via PumpPortal (local tx, signed here, never share the key).
// Returns the amount of SOL gained (0 if nothing to claim).
async function claimCreatorFees() {
  init();
  if (!keypair) throw new Error('no keypair configured');
  const before = await conn.getBalance(keypair.publicKey);

  const r = await fetch('https://pumpportal.fun/api/trade-local', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      publicKey: keypair.publicKey.toBase58(),
      action: 'collectCreatorFee',
      priorityFee: 0.000001,
    }),
  });
  if (!r.ok) throw new Error('PumpPortal HTTP ' + r.status + ': ' + (await r.text()).slice(0, 200));

  const tx = web3.VersionedTransaction.deserialize(new Uint8Array(await r.arrayBuffer()));
  tx.sign([keypair]);
  const sig = await conn.sendTransaction(tx);
  await conn.confirmTransaction(sig, 'confirmed');

  const after = await conn.getBalance(keypair.publicKey);
  const gained = Math.max(0, (after - before) / web3.LAMPORTS_PER_SOL);
  console.log(`[solana] claimed ${gained.toFixed(6)} SOL (tx ${sig})`);
  return gained;
}

// Send SOL from the creator wallet to a player (used only when DISTRIBUTE_ONCHAIN=true)
async function sendSol(toWallet, amountSol) {
  init();
  if (!keypair) throw new Error('no keypair configured');
  const tx = new web3.Transaction().add(
    web3.SystemProgram.transfer({
      fromPubkey: keypair.publicKey,
      toPubkey: new web3.PublicKey(toWallet),
      lamports: Math.floor(amountSol * web3.LAMPORTS_PER_SOL),
    })
  );
  const sig = await web3.sendAndConfirmTransaction(conn, tx, [keypair]);
  console.log(`[solana] paid ${amountSol.toFixed(6)} SOL to ${toWallet} (tx ${sig})`);
  return sig;
}

module.exports = {
  available: () => available,
  init,
  tokenBalance,
  claimCreatorFees,
  sendSol,
  HOLD_REQUIREMENT,
  STRICT_HOLD,
  DISTRIBUTE_ONCHAIN,
  MIN_PAYOUT_SOL,
};
