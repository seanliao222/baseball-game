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
- **Lineup editor** — the pre-game lineup shows each starter's defensive position; swap batting order, swap positions, or replace any starter / the starting pitcher from the bench (single-player).
- **Stamina** — workload = pitches + stress (hits +2/3/5, walks +1.5, every run allowed +2.5), counted even in auto-sim; once workload passes about half his stamina his velocity (up to ~7 mph / ~11 km/h) and control drop.
- **Pickoffs** — when pitching you can throw over to any occupied base, up to 3 times per batter; a 3rd failed attempt is a balk.
- **Fielding range** — fielders shift toward the pull side and play deeper for power hitters. A batted ball is checked against every fielder's actual position (reaction delay + sprint speed): an out always lands where some fielder can get to it in time, a base hit only where nobody can (with a safety margin, so fly balls that look catchable no longer turn into doubles). After a catch or a fielded hit the ball is thrown — infield hits to first, outfield hits/catches in to second, infield catches tossed to a teammate — with a visible throwing motion; ground outs and double plays throw as before.
- **Pawapuro-style faces** — players have big white eyes with blue irises and no nose, in the style of the classic パワプロ chibi characters.
- **In-game defensive adjustments** — while your team is pitching, the 🧢 守備調整 button (single player) lets you swap fielders' positions or substitute a bench player (the replaced player is out for the game). Playing someone away from his natural position is flagged in red and raises the chance of errors.
- **AI manager** — the computer changes pitchers only when the pitcher is truly shelled (6+ runs / 5+ in an inning / 4+ runs on 7+ hits, and already worn down), out of gas (workload past his stamina, 25+ pitches), or the game is far gone (down 8+ after the 4th).
- **Versus mode (QR / PeerJS)** — host and guest each pick a team and play head-to-head. Each screen shows only its own role: the pitcher gets the behind-the-mound view with the pitch wheel / aim / power bar, the batter gets the batter view and timing bar and never sees the pitch selection.
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
