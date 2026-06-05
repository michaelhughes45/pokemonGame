# Testing Plan — Milestones 4.4 to 4.7

All moves should be assigned via the **Move Reminder** after the DM gives the Pokémon.
If a move doesn't appear for a species in the reminder, use the listed alternative.
Sessions 1–5 can be run solo (DM controls both sides). Session 6 benefits from a second account.

---

## Session 1 — Stat Stages, Recoil, Drain, Recovery

**Your side (player controls):**

| Pokémon | Level | Moves |
|---|---|---|
| Lucario | 50 | Swords Dance, Drain Punch, Bulk Up, Iron Head |
| Rapidash | 50 | Flare Blitz, Fire Blast, Agility, High Horsepower |
| Chansey | 40 | Soft-Boiled, Growl, Double Slap, Minimize |

**NPC side (DM controls):**

| Pokémon | Level | Ability | Moves |
|---|---|---|---|
| Blastoise | 50 | Torrent | Growl, Surf, Ice Beam, Protect |
| Arcanine | 50 | Intimidate | Fire Fang, Extreme Speed, Crunch, Agility |

Start with Blastoise. Use Growl to stack -1 Atk on Lucario. Damage Blastoise to low HP to trigger Torrent.
Send out Arcanine second to test Intimidate entry dropping Lucario's Atk on switch-in.

**Checklist:**
- [ ] Use Swords Dance → green +2 Atk pill appears
- [ ] NPC uses Growl → red -1 Atk pill appears on your Pokémon
- [ ] Stack boosts to +6 → confirm it stops there
- [ ] Use Flare Blitz → recoil damage logged; confirm no recoil on a miss
- [ ] Use Drain Punch → attacker regains HP, turn log shows drain
- [ ] Use Soft-Boiled → ~50% HP restored
- [ ] Switch Lucario out and back in → all stat stage pills gone
- [ ] Send out Arcanine (Intimidate) → all active opponents instantly show -1 Atk
- [ ] Damage Blastoise to low HP (Torrent threshold) → confirm Water move damage increases

---

## Session 2 — Dream Eater, Rest, Close Combat Self-Drop

**Your side:**

| Pokémon | Level | Moves |
|---|---|---|
| Gengar | 45 | Dream Eater, Hypnosis, Shadow Ball, Thunderbolt |
| Lucario | 50 | Close Combat, Swords Dance, Drain Punch, Iron Head *(same as session 1)* |

**NPC side:**

| Pokémon | Level | Moves |
|---|---|---|
| Jigglypuff | 30 | Sing, Pound, Body Slam, Disarming Voice |
| Blissey | 50 | Soft-Boiled, Seismic Toss, Sing, Aromatherapy |

**Checklist:**
- [ ] NPC uses Sing → your Pokémon gets SLP badge
- [ ] Use Dream Eater on an awake target → "no effect" in log, no damage
- [ ] Get target to sleep, then use Dream Eater → damage + HP drained
- [ ] Use Rest on Lucario at low HP → full heal, SLP badge, sleeps exactly 2 turns then wakes
- [ ] Use Close Combat → damage dealt + guaranteed -1 Def and -1 SpDef on Lucario after

---

## Session 3 — Priority, Flinch, Two-Turn Moves

**Your side:**

| Pokémon | Level | Moves |
|---|---|---|
| Staraptor | 50 | Quick Attack, Fly, Brave Bird, Close Combat |
| Lucario | 50 | Iron Head, Extreme Speed, Swords Dance, Drain Punch *(same as session 1)* |

**NPC side:**

| Pokémon | Level | Moves |
|---|---|---|
| Snorlax | 50 | Body Slam, Yawn, Rest, Roar |
| Skarmory | 45 | Steel Wing, Whirlwind, Spikes, Air Slash |

**Checklist:**
- [ ] Staraptor uses Quick Attack → fires before Snorlax's move regardless of turn order
- [ ] Lucario (faster) uses Iron Head on Snorlax → Snorlax occasionally "flinched and couldn't move"
- [ ] Confirm flinch does NOT proc when a slower Pokémon attacks a faster one
- [ ] NPC Snorlax uses Roar → confirm it resolves last in the round
- [ ] Use Fly turn 1 → charging message logged, semi-invulnerable volatile set, no damage
- [ ] Turn 2 → Fly deals damage and both volatiles are cleared
- [ ] Use Brave Bird → recoil damage logged (bonus double-check from session 1)

---

## Session 4 — Solar Beam, Geomancy, Roost, Weather Abilities

**Your side:**

| Pokémon | Level | Moves |
|---|---|---|
| Venusaur | 50 | Solar Beam, Synthesis, Sleep Powder, Sludge Bomb |
| Togekiss | 50 | Roost, Air Slash, Dazzling Gleam, Thunder Wave |
| Xerneas | 60 | Geomancy, Moonblast, Dazzling Gleam, Horn Leech |

**NPC side:**

| Pokémon | Level | Ability | Moves |
|---|---|---|---|
| Torkoal | 40 | Drought | Lava Plume, Yawn, Body Press, Iron Defense |
| Politoed | 40 | Drizzle | Scald, Hypnosis, Ice Beam, Protect |

**Checklist:**
- [ ] No weather active — use Solar Beam → charges turn 1, fires turn 2
- [ ] Send out Torkoal → sun activates via Drought ability, log shows it
- [ ] Use Solar Beam in sun → skips charge, fires immediately on turn 1
- [ ] Send out Politoed while sun is active → both weathers cancel and clear
- [ ] Use Geomancy with Xerneas → charging turn 1; turn 2 shows +2 SpAtk, +2 SpDef, +2 Speed
- [ ] Use Roost with Togekiss (Flying type) → HP restored
- [ ] End of that round: Ground moves should now connect on Togekiss (Flying type removed)
- [ ] Next round: Ground immunity restored on Togekiss

---

## Session 5 — Multi-Hit, Aurora Beam, Secondary Effects, Draco Meteor

**Your side:**

| Pokémon | Level | Moves |
|---|---|---|
| Cloyster | 50 | Rock Blast, Icicle Spear, Razor Shell, Shell Smash |
| Lapras | 50 | Aurora Beam, Ice Beam, Surf, Thunderbolt |
| Dragonite | 60 | Draco Meteor, Dragon Claw, Extreme Speed, Fire Punch |
| Jolteon | 45 | Charge Beam, Thunder, Thunderbolt, Shadow Ball |

**NPC side:**

| Pokémon | Level | Moves |
|---|---|---|
| Clefable | 50 | Moonblast, Soft-Boiled, Thunder Wave, Wish *(tanky dummy target)* |
| Tyranitar | 55 | Crunch, Stone Edge, Dragon Dance, Earthquake |

**Checklist:**
- [ ] Use Rock Blast → turn log shows 2–5 separate hit entries
- [ ] Faint a target mid-multi-hit sequence → remaining hits stop
- [ ] Use Aurora Beam several times → deals damage + occasional -1 Atk on target (~10%); confirm NO freeze
- [ ] Use Draco Meteor → damage + guaranteed -2 SpAtk on Dragonite every cast
- [ ] Use Charge Beam → damage + +1 SpAtk on Jolteon most of the time (~70%)
- [ ] Have NPC Tyranitar use Crunch several times → occasional -1 Def on target (~20%)

---

## Session 6 — Encounter Builder (DM UI + PvE N-slots + Wild Multi-Catch)

**Pre-build this NPC before starting:**
- Gym Leader NPC with a party of 3: Machamp (Lv 45), Conkeldurr (Lv 47), Hariyama (Lv 43)

**Encounter Builder:**
- [ ] DM creates a PvE encounter using that NPC → appears in encounter list
- [ ] DM edits it → changes persist
- [ ] DM deletes it → removed from list
- [ ] DM creates a Wild encounter with 2 entries: Ralts (Lv 10, catchable) + Kirlia (Lv 20, catchable)

**PvE N-slot launch (needs 2 player accounts):**
- [ ] Launch PvE encounter with 2 players → enemy side shows 2 separate slots for the NPC
- [ ] DM sends a different NPC Pokémon into each slot (slotIndex 0 and 1)
- [ ] DM submits a move for each slot independently; both resolve correctly

**Wild multi-catch:**
- [ ] Launch the 2-entry wild encounter → both Pokémon appear on enemy side
- [ ] Target picker appears above ball list; ball buttons disabled until target selected
- [ ] Catch Ralts → only Ralts transfers; Kirlia remains active
- [ ] Set wildCatchable: false on a new encounter → confirm Ball tab does not appear

---

## Notes

- Check off items as you go — you can stop and resume any session
- Sessions 1–5 are fully solo (DM controls both sides in the same browser or two tabs)
- Session 6 N-slot test needs a second account logged in as a player; Wild catch portion is solo
- If a move isn't available via Move Reminder for a suggested Pokémon, substitute a similar move of the same category (another recoil move, another drain move, etc.)
