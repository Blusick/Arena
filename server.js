// Football Island Clicker - Leaderboard server
// Local: node server.js  ->  http://localhost:3000
// Render: set Start Command to "npm start" (PORT is provided automatically)

const express = require('express');
const fs = require('fs');
const path = require('path');
const solana = require('./solana');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'leaderboard.json');
const REWARDS_FILE = path.join(__dirname, 'rewards.json');

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function loadBoard() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function saveBoard(board) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(board, null, 2));
}

// Top 10 by total cumulative balls
app.get('/api/leaderboard', (req, res) => {
  const board = loadBoard();
  const top = Object.values(board)
    .sort((a, b) => b.totalBalls - a.totalBalls)
    .slice(0, 10)
    .map(({ pseudo, wallet, totalBalls, level }) => ({
      pseudo,
      wallet: wallet.slice(0, 4) + '...' + wallet.slice(-4), // never expose full wallet
      totalBalls,
      level
    }));
  res.json(top);
});

// Global rank of a wallet among all players
app.get('/api/rank/:wallet', (req, res) => {
  const board = loadBoard();
  const sorted = Object.values(board).sort((a, b) => b.totalBalls - a.totalBalls);
  const i = sorted.findIndex(p => p.wallet === req.params.wallet);
  res.json({ rank: i >= 0 ? i + 1 : null, total: sorted.length });
});

// Upsert a player's score (keyed by wallet, keeps highest total)
app.post('/api/score', (req, res) => {
  const { pseudo, wallet, totalBalls, level } = req.body || {};
  if (
    typeof pseudo !== 'string' || pseudo.trim().length < 1 || pseudo.length > 20 ||
    typeof wallet !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(wallet) ||
    typeof totalBalls !== 'number' || !isFinite(totalBalls) || totalBalls < 0 ||
    typeof level !== 'number' || level < 1
  ) {
    return res.status(400).json({ error: 'Invalid payload' });
  }
  const board = loadBoard();
  const prev = board[wallet];
  board[wallet] = {
    pseudo: pseudo.trim(),
    wallet,
    totalBalls: Math.max(Math.floor(totalBalls), prev ? prev.totalBalls : 0),
    level: Math.max(Math.floor(level), prev ? prev.level : 1),
    updatedAt: Date.now()
  };
  saveBoard(board);
  res.json({ ok: true });
});

/* ================= WALLET GATING ================= */
const holdLabel = (n) => (n >= 1000 && n % 1000 === 0) ? (n / 1000) + 'k' : String(n);

app.post('/api/verify-wallet', async (req, res) => {
  const { wallet } = req.body || {};
  if (typeof wallet !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(wallet)) {
    return res.status(400).json({ ok: false, error: 'invalid' });
  }
  const required = solana.HOLD_REQUIREMENT;
  if (!solana.available()) {
    // deps not installed: let players in (local dev), flag as unverified
    return res.json({ ok: true, verified: false, required, requiredLabel: holdLabel(required) });
  }
  try {
    const balance = await solana.tokenBalance(wallet);
    res.json({ ok: balance >= required, verified: true, balance, required, requiredLabel: holdLabel(required) });
  } catch (e) {
    console.error('[verify-wallet]', e.message);
    if (solana.STRICT_HOLD) res.json({ ok: false, error: 'rpc', required, requiredLabel: holdLabel(required) });
    else res.json({ ok: true, verified: false, required, requiredLabel: holdLabel(required) });
  }
});

/* ================= CREATOR REWARDS ================= */
function loadRewards() {
  try { return JSON.parse(fs.readFileSync(REWARDS_FILE, 'utf8')); }
  catch { return { totalClaimed: 0, players: {}, lastClaimAt: null, lastClaimAmount: 0 }; }
}
function saveRewards(r) { fs.writeFileSync(REWARDS_FILE, JSON.stringify(r, null, 2)); }

// Reward split of each claim: top 1-5 -> 5% each, 6-15 -> 1% each, 16-50 -> 0.4% each (49% total)
function shareForRank(rankIdx) {
  if (rankIdx < 5) return 0.05;
  if (rankIdx < 15) return 0.01;
  if (rankIdx < 50) return 0.004;
  return 0;
}

function distribute(rewards, amountSol) {
  const board = loadBoard();
  const top = Object.values(board).sort((a, b) => b.totalBalls - a.totalBalls).slice(0, 50);
  top.forEach((p, i) => {
    const share = amountSol * shareForRank(i);
    if (share <= 0) return;
    if (!rewards.players[p.wallet]) rewards.players[p.wallet] = { earned: 0, paid: 0, pseudo: p.pseudo };
    rewards.players[p.wallet].earned += share;
    rewards.players[p.wallet].pseudo = p.pseudo;
  });
}

// Optional real on-chain payouts (DISTRIBUTE_ONCHAIN=true in .env)
async function sendPayouts(rewards) {
  for (const [wallet, p] of Object.entries(rewards.players)) {
    const pending = p.earned - p.paid;
    if (pending < solana.MIN_PAYOUT_SOL) continue;
    try {
      await solana.sendSol(wallet, pending);
      p.paid += pending;
      saveRewards(rewards);
    } catch (e) {
      console.error('[payout]', wallet, e.message);
    }
  }
}

let claiming = false;
async function claimCycle() {
  if (claiming || !solana.available()) return;
  claiming = true;
  try {
    const rewards = loadRewards();
    const claimed = await solana.claimCreatorFees();
    rewards.lastClaimAt = Date.now();
    rewards.lastClaimAmount = claimed;
    if (claimed > 0) {
      rewards.totalClaimed += claimed;
      distribute(rewards, claimed);
    }
    saveRewards(rewards);
    if (solana.DISTRIBUTE_ONCHAIN) await sendPayouts(rewards);
  } catch (e) {
    console.error('[claim-cycle]', e.message);
  }
  claiming = false;
}
setInterval(claimCycle, 120000); // every 2 minutes
setTimeout(claimCycle, 8000);    // first attempt shortly after boot

app.get('/api/rewards', (req, res) => {
  const rewards = loadRewards();
  const me = req.query.wallet ? rewards.players[req.query.wallet] : null;
  res.json({
    totalClaimed: rewards.totalClaimed,
    lastClaimAt: rewards.lastClaimAt,
    lastClaimAmount: rewards.lastClaimAmount,
    yourRewards: me ? me.earned : 0,
    yourPaid: me ? me.paid : 0,
  });
});

app.listen(PORT, () => console.log(`Football Island Clicker running on port ${PORT}`));
