# Football Island Clicker ⚽

Pixel clicker game on a floating football island, with an online leaderboard.

## Run locally

```bash
npm install
npm start
```

Open http://localhost:3000

## Deploy on Render

1. Push this folder to a GitHub repo.
2. On Render: **New → Web Service**, connect the repo.
3. Build command: `npm install` — Start command: `npm start` (PORT is auto-provided).
4. Note: Render's free tier has an ephemeral disk, so `leaderboard.json` resets on redeploy. For permanent scores, add a Render Disk or swap the JSON file for a database (the storage code is isolated in `loadBoard`/`saveBoard` in `server.js`).

## Game rules

- **Click the pitch** to earn balls. Ball Lv1 = 2 balls/click, each ball level ×1.3 (rounded).
- **Ball upgrades**: Lv2 100 → Lv10 15,000 balls.
- **Player level**: based on clicks (Lv2 at 200 clicks … Lv8 at 20,000, then ×2 per level).
- **Footballers** (passive income, unlocked by level): Payne → Messi (2 → 300 balls/sec).
- **Accessories**: Boots +5/s, Shorts +10/s, Jersey +20/s.
- **Golden ball**: every 2 min for 5s → ×5 clicks for 5s.
- **Silver ball**: every 1 min for 8s → instant 100× your per-click value.
- **Quests**: click milestones (reward = milestone) and squad-size milestones.
- **Leaderboard**: top 10 by total cumulative balls, shared online via the server.

Progress is saved in the browser per wallet address.
