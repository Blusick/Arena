// Football Island Clicker - Leaderboard server
// Local: node server.js  ->  http://localhost:3000
// Render: set Start Command to "npm start" (PORT is provided automatically)

const express = require('express');
const fs = require('fs');
const path = require('path');
const solana = require('./solana');

const app = express();
const PORT = process.env.PORT || 3000;
// DATA_DIR lets you point game data at a persistent disk (e.g. /data on Render)
// so deploys never wipe the leaderboard or the payout history.
const DATA_DIR = process.env.DATA_DIR || __dirname;
const DATA_FILE = path.join(DATA_DIR, 'leaderboard.json');
const REWARDS_FILE = path.join(DATA_DIR, 'rewards.json');

/* ===== ONE-TIME DATA WIPE =====
   Bump DATA_VERSION to wipe ALL server stats (leaderboard + rewards)
   exactly once on the next deploy, wherever the data lives. */
const DATA_VERSION = 2; // v1.1 update: full reset (cheaters on the BETA)
const VERSION_FILE = path.join(DATA_DIR, 'data-version.json');
(function migrateData() {
  let v = 0;
  try { v = JSON.parse(fs.readFileSync(VERSION_FILE, 'utf8')).version || 0; } catch {}
  if (v < DATA_VERSION) {
    try { fs.writeFileSync(DATA_FILE, '{}\n'); } catch (e) { console.error('[reset]', e.message); }
    try {
      fs.writeFileSync(REWARDS_FILE, JSON.stringify(
        { totalClaimed: 0, players: {}, lastClaimAt: null, lastClaimAmount: 0 }, null, 2));
    } catch (e) { console.error('[reset]', e.message); }
    fs.writeFileSync(VERSION_FILE, JSON.stringify({ version: DATA_VERSION, wipedAt: Date.now() }));
    console.log(`[reset] ALL STATS WIPED (data version ${v} -> ${DATA_VERSION})`);
  }
})();

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

// Top 30 by total cumulative balls (banned players excluded)
app.get('/api/leaderboard', (req, res) => {
  const board = loadBoard();
  const top = Object.values(board)
    .filter(p => !p.banned)
    .sort((a, b) => b.totalBalls - a.totalBalls)
    .slice(0, 30)
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
  const sorted = Object.values(board).filter(p => !p.banned).sort((a, b) => b.totalBalls - a.totalBalls);
  const i = sorted.findIndex(p => p.wallet === req.params.wallet);
  res.json({ rank: i >= 0 ? i + 1 : null, total: sorted.length });
});

/* ================= ANTI-CHEAT ================= */
const CHEAT = {
  maxTotalBalls: 10_000_000_000, // hard cap: +10B balls = ban
  maxBallsPerSec: 200_000,       // 1M balls / 5s = ban
  maxClicksPerSec: 15,           // 150 clicks / 10s = ban
  maxLevelJump: 2,               // +2 levels faster than 10s = ban
  levelJumpWindow: 10,           // seconds
  firstPostMaxClicks: 300,       // a brand-new player can't already have many clicks
};

// Level thresholds — MUST mirror the client (lv2:200 ... lv8:20000, then x2)
function clicksForLevel(level) {
  const t = [200, 500, 1000, 2000, 5000, 10000, 20000];
  if (level <= 1) return 0;
  if (level <= 8) return t[level - 2];
  return 20000 * Math.pow(2, level - 8);
}
function levelFromClicks(c) {
  let lv = 1;
  while (c >= clicksForLevel(lv + 1)) lv++;
  return lv;
}

// Generous ceilings of what is physically earnable for a given click count.
// Early players can't have late-game per-click or passive income.
function maxPerClickFor(ck) { // includes x5 golden boost
  if (ck < 500) return 25;
  if (ck < 2000) return 60;
  if (ck < 10000) return 175;
  return 505; // ball lv15 (101/click) x5
}
function maxPassiveFor(ck) {
  if (ck < 500) return 10;
  if (ck < 2000) return 30;
  if (ck < 10000) return 120;
  return 620; // every footballer + accessory
}
function maxBallsFor(ck, elapsedSec) {
  const mpc = maxPerClickFor(ck);
  return ck * mpc                          // clicking (always boosted)
    + ck * 4 + 3000                        // quest rewards cushion
    + elapsedSec * maxPassiveFor(ck)       // passive income
    + (elapsedSec / 60) * 20 * mpc;        // golden boot every minute
}

function detectCheat(prev, tb, ck, lv, now) {
  if (tb > CHEAT.maxTotalBalls) return `holds ${tb} balls (cap ${CHEAT.maxTotalBalls})`;

  // the level is DERIVED from clicks: a level the clicks can't justify = injected
  const maxLv = levelFromClicks(ck);
  if (lv > maxLv) return `level ${lv} with only ${ck} clicks (max possible: lv${maxLv})`;

  if (!prev || !prev.updatedAt) {
    // first report of this wallet: it must look like a fresh start
    if (ck > CHEAT.firstPostMaxClicks) return `new player starting with ${ck} clicks`;
    if (tb > maxBallsFor(ck, 60)) return `new player starting with ${tb} balls (${ck} clicks)`;
    return null;
  }

  const dt = (now - prev.updatedAt) / 1000;
  const elapsed = Math.max(1, (now - (prev.firstSeenAt || prev.updatedAt)) / 1000);

  // lifetime consistency: clicks and balls vs total session time
  if (ck > elapsed * CHEAT.maxClicksPerSec + CHEAT.firstPostMaxClicks) {
    return `${ck} clicks in a ${Math.round(elapsed)}s session`;
  }
  if (tb > maxBallsFor(ck, elapsed)) {
    return `${tb} balls impossible with ${ck} clicks in ${Math.round(elapsed)}s (max ~${Math.floor(maxBallsFor(ck, elapsed))})`;
  }

  if (dt < 0.5) return null; // ignore double-fires
  const ballsRate = (tb - prev.totalBalls) / dt;
  const clickRate = (ck - (prev.clicks || 0)) / dt;
  const lvlJump = lv - (prev.level || 1);
  if (ballsRate > CHEAT.maxBallsPerSec) return `balls rate ${Math.round(ballsRate)}/s`;
  if (clickRate > CHEAT.maxClicksPerSec) return `click rate ${clickRate.toFixed(1)}/s`;
  if (lvlJump >= CHEAT.maxLevelJump &&
      (dt < CHEAT.levelJumpWindow || lvlJump / dt > CHEAT.maxLevelJump / CHEAT.levelJumpWindow)) {
    return `level jump +${lvlJump} in ${Math.round(dt)}s`;
  }
  return null;
}

// Clients older than this version are ignored (they push pre-reset scores)
const CLIENT_VERSION = 3;

// Upsert a player's score (keyed by wallet, keeps highest total)
app.post('/api/score', (req, res) => {
  const { pseudo, wallet, totalBalls, level, clicks, v } = req.body || {};
  if ((v | 0) < CLIENT_VERSION) return res.json({ ok: false, outdated: true });
  if (
    typeof pseudo !== 'string' || pseudo.trim().length < 1 || pseudo.length > 20 ||
    typeof wallet !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(wallet) ||
    typeof totalBalls !== 'number' || !isFinite(totalBalls) || totalBalls < 0 ||
    typeof level !== 'number' || level < 1 ||
    (clicks !== undefined && (typeof clicks !== 'number' || !isFinite(clicks) || clicks < 0))
  ) {
    return res.status(400).json({ error: 'Invalid payload' });
  }
  const board = loadBoard();
  const prev = board[wallet];
  if (prev && prev.banned) return res.json({ ok: false, banned: true });

  const now = Date.now();
  const tb = Math.floor(totalBalls);
  const ck = Math.floor(clicks || 0);
  const lv = Math.floor(level);

  const cheat = detectCheat(prev, tb, ck, lv, now);
  if (cheat) {
    board[wallet] = {
      ...(prev || {}),
      pseudo: pseudo.trim(), wallet,
      totalBalls: prev ? prev.totalBalls : 0,
      level: prev ? prev.level : 1,
      clicks: prev ? (prev.clicks || 0) : 0,
      banned: true, banReason: cheat, bannedAt: now, updatedAt: now,
    };
    saveBoard(board);
    console.warn(`[anticheat] BANNED ${pseudo.trim()} (${wallet}): ${cheat}`);
    return res.json({ ok: false, banned: true });
  }

  board[wallet] = {
    pseudo: pseudo.trim(),
    wallet,
    totalBalls: Math.max(tb, prev ? prev.totalBalls : 0),
    level: Math.max(lv, prev ? prev.level : 1),
    clicks: Math.max(ck, prev ? (prev.clicks || 0) : 0),
    firstSeenAt: prev ? (prev.firstSeenAt || prev.updatedAt) : now,
    updatedAt: now,
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
  const top = Object.values(board).filter(p => !p.banned)
    .sort((a, b) => b.totalBalls - a.totalBalls).slice(0, 50);
  top.forEach((p, i) => {
    const share = amountSol * shareForRank(i);
    if (share <= 0) return;
    if (!rewards.players[p.wallet]) rewards.players[p.wallet] = { earned: 0, paid: 0, pseudo: p.pseudo };
    rewards.players[p.wallet].earned += share;
    rewards.players[p.wallet].pseudo = p.pseudo;
  });
}

// Live event feed shown in the game (kept in memory, last 30)
let events = [];
function addEvent(e) {
  events.push({ ...e, at: Date.now() });
  if (events.length > 30) events = events.slice(-30);
}
app.get('/api/events', (req, res) => res.json(events));

// Optional real on-chain payouts (DISTRIBUTE_ONCHAIN=true in .env)
async function sendPayouts(rewards) {
  let count = 0, total = 0;
  for (const [wallet, p] of Object.entries(rewards.players)) {
    const pending = p.earned - p.paid;
    if (pending < solana.MIN_PAYOUT_SOL) continue;
    try {
      await solana.sendSol(wallet, pending);
      p.paid += pending;
      count++; total += pending;
      saveRewards(rewards);
    } catch (e) {
      console.error('[payout]', wallet, e.message);
    }
  }
  return { count, total };
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
    addEvent({ type: 'claim', amount: claimed });
    if (claimed > 0) {
      rewards.totalClaimed += claimed;
      distribute(rewards, claimed);
    }
    saveRewards(rewards);
    if (solana.DISTRIBUTE_ONCHAIN) {
      const paid = await sendPayouts(rewards);
      if (paid.count > 0) addEvent({ type: 'payout', players: paid.count, amount: paid.total });
    }
    logStats();
  } catch (e) {
    console.error('[claim-cycle]', e.message);
  }
  claiming = false;
}

function computeStats() {
  const board = loadBoard();
  const all = Object.values(board);
  const active = all.filter(p => !p.banned);
  const online = active.filter(p => Date.now() - p.updatedAt < 60000).length;
  const rewards = loadRewards();
  const totalRewardsGiven = Object.values(rewards.players).reduce((s, p) => s + p.earned, 0);
  return {
    online,
    totalPlayers: active.length,
    bannedPlayers: all.length - active.length,
    totalRewardsGiven,
    totalClaimed: rewards.totalClaimed,
  };
}
function logStats() {
  const s = computeStats();
  console.log(`[stats] total players: ${s.totalPlayers} | online: ${s.online} | banned: ${s.bannedPlayers} | total rewards given to players: ${s.totalRewardsGiven.toFixed(6)} SOL | total claimed: ${s.totalClaimed.toFixed(6)} SOL`);
}

app.get('/api/stats', (req, res) => res.json(computeStats()));

// Full leaderboard dump with complete wallets + ban info (admin only).
// Usage: curl https://YOUR-APP/api/admin/board -H "x-admin-token: TOKEN"
app.get('/api/admin/board', (req, res) => {
  const token = process.env.ADMIN_TOKEN;
  if (!token || req.headers['x-admin-token'] !== token) {
    return res.status(403).json({ error: 'forbidden' });
  }
  const board = loadBoard();
  const rows = Object.values(board).sort((a, b) => b.totalBalls - a.totalBalls);
  res.json(rows);
});

// Manually ban a wallet (for cheaters who slipped through before this patch).
// Usage: curl -X POST https://YOUR-APP/api/admin/ban -H "x-admin-token: TOKEN" -H "Content-Type: application/json" -d '{"wallet":"..."}'
app.post('/api/admin/ban', (req, res) => {
  const token = process.env.ADMIN_TOKEN;
  if (!token || req.headers['x-admin-token'] !== token) {
    return res.status(403).json({ error: 'forbidden' });
  }
  const { wallet } = req.body || {};
  const board = loadBoard();
  if (!wallet || !board[wallet]) return res.status(404).json({ error: 'wallet not found' });
  board[wallet].banned = true;
  board[wallet].banReason = 'manual ban (admin)';
  board[wallet].bannedAt = Date.now();
  saveBoard(board);
  console.warn(`[anticheat] BANNED ${board[wallet].pseudo} (${wallet}): manual ban (admin)`);
  res.json({ ok: true, banned: wallet });
});

// Remote full reset, protected by ADMIN_TOKEN (set it in the environment).
// Usage: curl -X POST https://YOUR-APP.onrender.com/api/admin/reset -H "x-admin-token: YOUR_TOKEN"
app.post('/api/admin/reset', (req, res) => {
  const token = process.env.ADMIN_TOKEN;
  if (!token || req.headers['x-admin-token'] !== token) {
    return res.status(403).json({ error: 'forbidden' });
  }
  fs.writeFileSync(DATA_FILE, '{}\n');
  fs.writeFileSync(REWARDS_FILE, JSON.stringify(
    { totalClaimed: 0, players: {}, lastClaimAt: null, lastClaimAmount: 0 }, null, 2));
  fs.writeFileSync(VERSION_FILE, JSON.stringify({ version: DATA_VERSION, wipedAt: Date.now() }));
  console.log('[reset] ALL STATS WIPED via admin endpoint');
  res.json({ ok: true, message: 'All stats wiped' });
});
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

app.listen(PORT, () => {
  console.log(`Football Arena running on port ${PORT}`);
  logStats();
});
