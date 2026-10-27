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
- **Fielding range** — fielders shift toward the pull side and play deeper for power hitters. A batted ball is checked against every fielder's actual position (reaction delay + sprint speed): an out always lands where some fielder can get to it in time, a base hit only where nobody can (with a safety margin, so fly balls that look catchable no longer turn into doubles). After a catch or a fielded hit the ball is thrown — infield hits to first, outfield hits/catches in to second, infield catches tossed to a teammate — with a visible throwing motion; ground outs and double plays throw as before. On a base hit the runners now sprint to arrive just ahead of the throw, instead of jogging in after the ball is already at the bag. Fixed: a computer batter's swing could be shown but the pitch called a ball — a swing is now always judged as a swing. Computer batters now chase pitches just off the zone (more with two strikes, less if they have good contact) instead of almost never swinging at balls. The computer's swing decision no longer peeks at the true ball/strike call: it judges where the pitch *looks* to be (noise shrinks with 選球), swings more often overall, and swings at close pitches about as often as at strikes.
- **Ability values (實況-style)** — every batter has estimated 彈道 (1–4, from isolated power / homers), 巧 / 力 / 走 (existing), 肩 and 守 (from the position's demands plus speed / power, since the data has no throwing or fielding stats), and 選球 (OBP − AVG, used for how often the computer chases bad pitches). Shown as grades (S/A/B/C/D…) on the batter card. 彈道 changes the grounder/fly mix, 守 (the defence's average) changes the error chance, 選球 changes chasing. Doubles and triples now land deep instead of as shallow bloops. Fielders now run at a steady pace after a reaction delay, so on a base hit the fielder visibly gets there too late instead of sprinting under a ball the game then calls a hit. With a man on first, a ground-ball single must now clear the infielders by a wide margin (so it never looks like a double-play ball). A player can carry a hand-set `def` / `arm` that overrides the estimate (CPBL Golden Glove winners get 守 from their win count — e.g. 江坤宇 S, 王威晨 / 李凱威 / 郭天信 A). CPBL stolen-base kings have their 走 raised to match (陳晨威, 張政禹, 李凱威, 王威晨, 林智平, 林立).
- **Bunting** — when batting (single player) press 🏏 觸擊 / **B** before the pitch to square around; then time the swing button as usual. A good bunt is a sacrifice (batter out, runners advance, a runner on third scores), sometimes a bunt single, a poor one pops up or goes foul (a foul bunt on two strikes is a strikeout) or misses. The computer also sacrifices in the right situations. The corner infielders charge and throw to first.
- **Triples** — a solid, well-struck ball (more likely off a fast batter) can fall into the gap and be legged out for a 3-base hit: every runner scores and the batter ends on third. The outfielder runs the ball down and relays it in through the cutoff man to third. Also in auto-simulated innings.
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
- **New players / pitches** — 富邦 廖祐霆 (9 pitches: 直球, 滑球, 橫掃滑, 曲球, 變速球, 指叉球, 卡特球 plus the new 上升直球 — rises at the last moment — and 魔球 — a knuckle-like pitch whose break is different every time). 中信兄弟 廖奕翔 is a two-way player like 大谷 (two-way, like 大谷; both are on the bench / bullpen list, not in the default starting lineup or rotation — pick them from the sub menu).
- **Ohtani arsenal** — 大谷 翔平 and 廖奕翔 throw 7 pitches: 直球, 橫掃滑 (his best), 指叉球, 滑球, 卡特球, 曲球, 伸卡球.
- **Individual stances / arm slots** — every batter now has his own stance (deep & wide power stance, upright high-bat contact stance, narrow open stance with a big bat waggle, leg-kick timer, or standard), picked from his power / contact and varied by a hash of his name. Pitchers have an arm slot: 上壓 overhand, 四分之三, 側投 and 低肩側投 — the throwing hand cocks and releases at that height, the trunk leans for lower slots, and the pitch leaves the hand from that height. Slots are assigned by a hash of the name (about 38% / 44% / 13% / 5%) unless a pitcher has a `slot` field.
- **Game record & history** — the game-over screen now lists 勝利投手 / 敗戰投手 (the pitcher on the mound when the winner took its final lead; a starter needs 5 innings or the win goes to the best reliever), 救援成功 (finisher who entered with a ≤3-run lead or pitched 3+ innings), 中繼成功 (relievers who entered with the lead and left it intact), 救援失敗 (blown save), 勝利打點 (who drove in the go-ahead run), every 全壘打 (inning, batter, 陽春砲 / N分砲) and an MVP from the winning team (batters by hits / HR / RBI, pitchers by innings / runs plus win or save). Each finished game is saved in the browser (localStorage, last 200) and shown on a new 📊 歷史戰績 screen from the title: W-L-D, win %, runs for / against, streak, and the last games with pitchers of record and MVP (paged; the list can be cleared).
- **Slower computer pitching** — when the computer pitches, the wait before the wind-up is about twice as long so a human batter has time to get set. Now ≈4.7 s, counted in real time instead of frames (a 120 Hz screen used to run the wait at double speed).
- **巧打 sizes the batting box** — the yellow contact box now scales clearly with the batter's 巧打 (about 0.7× at con 45, 1× at 66, 1.4× at 95; difficulty still scales it), and the contact-quality calculation uses the same scale, so a bigger box really means easier solid contact.
- **Bunt motion** — when a bunt is swung (hit, foul or miss) the batter now pushes the bat out to meet the ball and cushions it back, instead of snapping straight back to his normal stance. The waiting stance (擺短棒) is now a proper bunt stance: squared to the pitcher, knees bent low, bat held flat across the front with the barrel over the plate.
- **Bunt contact and fielding** — a bunted ball is now a soft tap that dribbles to a stop (small camera shake), and whoever is nearest of the pitcher, catcher, 1B or 3B charges in from where he stands, scoops it up and throws; the throw waits until he actually has it and the result call waits for the play.
- **強振 (power swing)** — a new 💥 強振 button (key V, next to 觸擊) turns the batting cursor into a small orange circle. The contact area shrinks to about 60%, so you must be more accurate (more misses, fouls and weak outs), but a clean hit is much more likely to be a home run or extra-base hit. Computer sluggers (power 72+) sometimes swing for the fences too. It resets every pitch and is exclusive with bunting.
- **強振 risk by ability** — on a power swing a hit can now turn into an out (and a foul into a swing-and-miss) with a chance that depends on 巧打 and 力量: about 3% for 90+/90+ hitters, 17% at 70, 30% at 50, 37% at 40 (home runs half as likely to be turned into outs), so weak hitters should not use it.
