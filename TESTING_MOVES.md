# Move System Test Roster

## Move Categories Covered

| Category | Implemented In |
|---|---|
| Status conditions (burn/paralysis/sleep/freeze/poison/toxic/confusion) | `STATUS_MOVES` |
| Self stat boosts / foe debuffs | `STAT_STAGE_MOVES` |
| Weather setters (rain) | `WEATHER_MOVES` |
| Weather-dependent recovery (Synthesis) | `RECOVERY_MOVES` |
| Two-turn charge move without semi-invuln | `CHARGE_MOVES` + Solar Beam |
| Recoil moves | `RECOIL_MOVES` |
| Fixed-count multi-hit | `MULTI_HIT_MOVES (fixed)` |
| Variable multi-hit (2–5) | `MULTI_HIT_MOVES (variable)` |
| Drain moves | `DRAIN_MOVES` |
| Flinch (30% and 100%) | `FLINCH_MOVES` |
| Priority moves (+2, +1, −4) | `MOVE_PRIORITY` |
| Focus Energy (crit rate) | battleController special handler |
| Aqua Ring (end-of-turn heal volatile) | battleController special handler |
| Leech Seed (end-of-turn drain) | battleController special handler |
| Ghost Curse (haunt foe) | battleController special handler |
| Guaranteed self SpA drop on damage | `STAT_STAGE_MOVES` (Leaf Storm) |
| Guaranteed self Def/SpD drop on damage | `STAT_STAGE_MOVES` (Close Combat) |

> **Not covered by level-up roster:** Protect/Detect family, semi-invulnerable 2-turn moves (Fly/Dig/Bounce), Belly Drum, Rest, Ingrain switch-lock, Non-Ghost Curse, Solar Beam sun skip, Sandstorm/Hail weather chip. See Bonus section to test these via DB/admin assignment.

---

## Player Team

The **Min Level** is the lowest level at which all four moves become available via Move Reminder. Use that level when creating the Pokémon, then swap any auto-assigned moves using the Move Reminder UI.

| # | Pokémon | Min Level | Move 1 | Move 2 | Move 3 | Move 4 |
|---|---|---|---|---|---|---|
| 1 | **Charizard** (Fire/Flying) | **21** | Flare Blitz *(recoil 1/3, Lv 1)* | Fire Fang *(burn 10%, Lv 19)* | Dragon Breath *(paralysis 30%, Lv 12)* | Scary Face *(Spe −2 foe, Lv 21)* |
| 2 | **Jolteon** (Electric) | **25** | Thunder Wave *(paralysis 100%, Lv 20)* | Thunderbolt *(damage + para 10%, Lv 25)* | Quick Attack *(priority +1, Lv 1)* | Sand Attack *(Acc −1 foe, Lv 1)* |
| 3 | **Machamp** (Fighting) | **43** | Bulk Up *(Atk +1 / Def +1, Lv 25)* | Focus Energy *(crit rate boost, Lv 1)* | Close Combat *(damage, Def/SpD −1 self, Lv 43)* | Mach Punch *(priority +1, Lv 22)* |
| 4 | **Lapras** (Water/Ice) | **31** | Ice Beam *(freeze 10%, Lv 31)* | Confuse Ray *(confusion 100%, Lv 7)* | Body Slam *(damage + paralysis 30%, Lv 13)* | Rain Dance *(weather: rain, Lv 22)* |
| 5 | **Venusaur** (Grass/Poison) | **53** | Sleep Powder *(sleep 100%, Lv 13)* | Poison Powder *(poison 100%, Lv 13)* | Synthesis *(weather recovery — 50% HP in normal weather, Lv 37)* | Solar Beam *(2-turn charge, fires turn 2, Lv 53)* |
| 6 | **Vaporeon** (Water) | **34** | Aqua Ring *(+1/16 HP/turn volatile, Lv 25)* | Water Pulse *(damage + confusion 20%, Lv 17)* | Acid Armor *(Def +2 self, Lv 24)* | Calm Mind *(SpA +1 / SpD +1 self, Lv 34)* |

---

## NPC Team

| # | Pokémon | Min Level | Move 1 | Move 2 | Move 3 | Move 4 |
|---|---|---|---|---|---|---|
| 1 | **Gengar** (Ghost/Poison) | **30** | Curse *(Ghost: haunt foe 1/4 HP/turn, cost 1/2 self HP, Lv 12)* | Will-O-Wisp *(burn 100%, Lv 14)* | Shadow Ball *(damage, SpD −20%, Lv 30)* | Toxic *(badly poisoned 100%, Lv 21)* |
| 2 | **Rhydon** (Ground/Rock) | **25** | Rock Slide *(damage, flinch 30%, Lv 25)* | Scary Face *(Spe −2 foe, Lv 1)* | Tail Whip *(Def −1 foe, Lv 1)* | Rock Blast *(variable multi-hit 2–5, Lv 23)* |
| 3 | **Dragonite** (Dragon/Flying) | **53** | Dragon Dance *(Atk +1 / Spe +1 self, Lv 53)* | Dragon Tail *(damage, priority −4, Lv 15)* | Extreme Speed *(damage, priority +2, Lv 1)* | Outrage *(Dragon damage, Lv 41)* |
| 4 | **Exeggutor** (Grass/Psychic) | **1** | Hypnosis *(sleep 100%, Lv 1)* | Giga Drain *(damage + drain 50%, Lv 1)* | Leaf Storm *(damage, SpA −2 self, Lv 1)* | Leech Seed *(drain foe 1/8 HP/turn, Lv 1)* |
| 5 | **Scyther** (Bug/Flying) | **25** | Air Slash *(damage, flinch 30%, Lv 18)* | Fury Cutter *(Bug physical — power doubles on consecutive hits, not tracked by system, Lv 4)* | Swords Dance *(Atk +2 self, Lv 25)* | Agility *(Spe +2 self, Lv 17)* |
| 6 | **Kangaskhan** (Normal) | **25** | Fake Out *(flinch 100%, priority +1, Lv 6)* | Comet Punch *(variable multi-hit 2–5, Lv 1)* | Dizzy Punch *(damage + confusion 20%, Lv 25)* | Double-Hit *(fixed 2-hit, Lv 19)* |

---

## Testing Checklist

- [ ] **Charizard** — Flare Blitz recoil (1/3 damage) appears in log; Fire Fang may burn (10%, test repeatedly); Dragon Breath may paralyse (30%); Scary Face drops foe Speed by 2 stages
- [ ] **Jolteon** — Thunder Wave paralyses 100%; paralysed Pokémon occasionally skips its turn; Thunderbolt may paralyse (10%); Quick Attack moves first vs same-priority moves; Sand Attack drops foe accuracy by 1 stage
- [ ] **Machamp** — Bulk Up raises own Attack and Defense by 1; Focus Energy volatile sets and crit rate visibly increases; Close Combat drops own Def and SpD by 1; Mach Punch outspeeds even faster Pokémon
- [ ] **Lapras** — Ice Beam freezes (test repeatedly for 10%); Confuse Ray confuses 100%; Body Slam may paralyse (30%); Rain Dance sets rain for 5 turns
- [ ] **Venusaur** — Sleep Powder puts target to sleep; Poison Powder poisons (regular, non-escalating); Synthesis restores 50% HP in normal weather; Solar Beam charges turn 1 and fires turn 2
- [ ] **Vaporeon** — Aqua Ring heals 1/16 max HP each turn; Water Pulse may confuse target (20%); Acid Armor raises own Def by 2 stages; Calm Mind raises own SpA and SpD by 1 each
- [ ] **Gengar** — Ghost Curse deducts half Gengar's HP and haunts foe; haunted foe loses 1/4 HP each end-of-turn; Will-O-Wisp burns 100%; Shadow Ball may drop SpD (20%); Toxic applies badly-poisoned escalating damage (×1 then ×2 then ×3 of 1/16 max HP)
- [ ] **Rhydon** — Rock Slide may flinch (30%); Scary Face drops foe Speed by 2; Tail Whip drops foe Defense by 1; Rock Blast hits 2–5 times (log shows each individual hit)
- [ ] **Dragonite** — Dragon Dance raises Atk and Spe by 1; Dragon Tail goes last (−4 priority) confirming negative priority; Extreme Speed goes first (+2 priority), confirm it beats Quick Attack (+1) and Mach Punch (+1); Outrage deals Dragon-type damage
- [ ] **Exeggutor** — Hypnosis induces sleep; Giga Drain restores 50% of damage dealt as HP; Leaf Storm hits hard then drops own SpA by 2; Leech Seed drains 1/8 foe HP each end-of-turn
- [ ] **Scyther** — Air Slash may flinch (30%); Fury Cutter deals Bug-type damage (power escalation on consecutive uses is not tracked — just verify it hits); Swords Dance raises Atk by 2; Agility raises Spe by 2
- [ ] **Kangaskhan** — Fake Out flinches 100% on the first turn only (fails on subsequent turns); Comet Punch hits 2–5 times; Dizzy Punch may confuse (20%); Double-Hit strikes exactly twice

---

## Bonus / Edge Cases

- **Semi-invulnerable 2-turn moves** (Fly, Dig, Bounce, Sky Attack, Dive) — all TM-only on the current roster; assign one via admin/DB to test the semi-invuln charge mechanic
- **Belly Drum** — no level-up equivalent on roster; assign via admin/DB to test the "max Atk, −50% HP" handler
- **Protect / Detect** — no level-up equivalent on roster; assign via admin/DB to test the protect-volatile family
- **Rest** — no level-up equivalent on roster; assign via admin/DB to test full-heal + self-sleep
- **Non-Ghost Curse** (+Atk/+Def/−Spe) — TM-only for all roster Pokémon; assign via admin/DB
- **Solar Beam skipping charge in sun** — no Sunny Day on roster; use admin to add it if this code path needs testing
- **Hail / Snow weather** — same end-of-turn chip as sandstorm; assign `hail` or `snowscape` to any NPC to verify
- **Sandstorm weather** — assign to any Rock/Ground/Steel NPC to verify chip damage on other types
- **Ingrain** *(+1/16 HP/turn + can't switch)* — Aqua Ring covers the per-turn heal; Ingrain's switch-lock is not on the roster; assign via admin/DB if needed
- **Geomancy** — non-semi-invuln charge move, fires triple SpA/SpD/Spe boost on second turn; assign via admin/DB
- **Draining Kiss / Oblivion Wing** — drain at 75% fraction instead of the standard 50%; assign via admin/DB
- **Leech Seed immunity** — Grass-type target should reject Leech Seed with "no effect" message (use Venusaur or Exeggutor as target)
- **Swagger confusion backfire** — Swagger boosts foe Atk by 2 AND confuses; assign via admin/DB and verify self-hits deal amplified damage
- **Rest wake-up** — assign Rest via admin/DB; confirm Pokémon wakes after exactly 2 full turns of sleep
