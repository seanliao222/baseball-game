# ⚾ Baseball Game — CPBL × MLB × WBC

A browser-based baseball game built with HTML5 Canvas, featuring teams from CPBL, MLB, and WBC. No installation required — just open `index.html` in any modern browser.

## 🎮 Play Online

**[▶ Launch Game](https://seanliao222.github.io/baseball-game/)**

## Features

- **17 teams** — 6 CPBL, 2 MLB, 9 WBC national teams
- **Pawapuro-style chibi characters** with team uniforms and hat logos
- **Full pitching system** — 9 pitch types (fastball, slider, curve, splitter, etc.) with velocity, control, and stamina ratings
- **Batting mechanics** — timing bar and contact/power/speed ratings
- **In-game scoreboard** — live SBO indicator, stamina gauge, batter/pitcher stat panels
- **Inning-by-inning box score** on Game Over screen
- **Pinch hitter & pitcher substitution** — full roster management mid-game
- **Mobile support** — on-screen buttons for phone/tablet play
- **Special players** — 廖宣皓 & 廖宣瑜 available on all teams as batter and pitcher subs

## Teams

| League | Teams |
|--------|-------|
| CPBL | 中信兄弟、樂天桃猿、統一獅、富邦悍將、味全龍、台鋼雄鷹 |
| MLB | New York Yankees、Los Angeles Dodgers |
| WBC | 中華隊、日本、韓國、美國、多明尼加、波多黎各、墨西哥、義大利、古巴 |

## How to Play

### Pitching (守備)
1. Select a pitch type from the wheel (直球、滑球、曲球…)
2. Aim with the directional buttons
3. Confirm to throw

### Batting (打擊)
1. Wait for the pitch
2. Hit the **SWING** button (or tap) when the ball enters the zone
3. Timing determines contact — early/late = foul, perfect = solid hit

### Substitutions
- Tap **換人** button during play to open the substitution menu
- Choose from available batters or pitchers not yet used

## Controls

| Action | Desktop | Mobile |
|--------|---------|--------|
| Confirm / Select | Click | Tap |
| Swing | Click in strike zone | Tap SWING button |
| Substitute | Click 換人 | Tap 換人 |

## Development

Single-file HTML5 app — all game logic, rendering, and assets are contained in `index.html`.

```
index.html     ← entire game (Canvas 2D, ~2200 lines)
```

### Recent Updates
- PM overhaul: fixed CPBL roster scope, score panel abbreviations, game-over box score, batter composite rating, pitch name labels always visible
- PO visual overhaul: team uniforms, hat logos, SBO indicator, stamina system
- Sound engine, pitch fatigue, steal base mechanics, ball flight physics
