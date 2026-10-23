# ⚾ Baseball Game — CPBL × MLB × WBC

A browser baseball game with a Three.js 3D broadcast view and a 2D TV-style HUD. No install — open `index.html` or play online.

## 🎮 Play Online

**[▶ Launch Game](https://seanliao222.github.io/baseball-game/)**

## Features

- **17 teams** (6 CPBL, 2 MLB, 9 WBC) with **25-man rosters** (12 pitchers + 13 position players) using real names, stats and lineups (CPBL 2026 incl. 中信兄弟 張士綸; NPB/KBO/ABL/WBC ratings partly estimated). 廖宣皓 / 廖宣瑜 are extra subs on every team, outside the 25.
- **Handedness** — every player has 投/打 (e.g. 左投左打, 右投左打); left-handed pitchers throw left-handed in 3D, lefty batters stand on the other side of the plate, switch hitters (左右打) bat opposite the pitcher; same-handed matchups slightly favour the pitcher.
- **3D stadium & players** — procedural stadium, outfield video board (batter close-up), home-team flags, articulated players, team uniforms (統一獅 orange/black, 中華隊 charcoal pinstripe + white pants + black cap, Dodgers white/blue, Yankees pinstripes).
- **Pitching** — pitch wheel, in-zone pitch-path preview, zoned power bar, pitcher-behind-the-mound view, per-pitcher pitch counts, speed on every pitch.
- **Batting** — timing bar tied to the ball, strike = any part of the ball touches the zone, pitch-history tracker next to the batter card.
- **Batted balls** — ground / line / fly / pop labels, diving "NICE PLAY" close-ups, double-play animation, sacrifice flies, umpire gestures.
- **Rules** — swinging at a ball is a strike, fouls (never strike three), steals (single / double / home), hit-by-pitch, wild pitch, fielding errors, infield-fly rule, walk-offs, extra innings, mercy rule (15 runs after 5 innings, 10 after 7).
- **AI manager** — the computer changes pitchers when they are shelled, tired, or trailing badly.
- **Versus mode (QR / PeerJS)** — host and guest each pick a team and play head-to-head.
- **Music** — each CPBL/WBC team has its own offense song (YouTube, highlights section, WebAudio fallback; phone gesture-unlock prompt). See `music/README.md`.
- **Mobile support** — touch controls, responsive HUD.

## How to Play

- **Pitch**: choose a pitch → aim in the zone → release with the power bar.
- **Bat**: tap/click when the timing marker is in the sweet zone; aim with the crosshair.
- **Steal**: use the steal button with runners on; **換人** opens the two-column substitution menu.

## Development

```
index.html      ← game logic, HUD, rosters, versus lobby
stadium3d.js    ← Three.js 3D stadium, players, poses, cameras
music/          ← team song list
```

Bump the `stadium3d.js?v=` cache-buster in `index.html` whenever the 3D file changes.
