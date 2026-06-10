# PokéTTRPG — Claude Context File

> This file is the project memory. Paste it at the start of every new Claude Code session
> or milestone chat. Update it at the end of each milestone before closing the session.

---

## Collaboration Style

The user is actively learning programming with the goal of getting a job in the field.
**Always explain what you are doing and why** — not just the code, but the reasoning:
- Why this approach over alternatives
- What the code/command actually does
- How it fits into the broader system
- Any relevant concepts a junior developer should know

Treat every task as a teaching moment without being condescending. Assume the user can
handle technical depth — just don't skip the explanation.

**Token discipline:** Only read files that are directly needed for the current task.
Do not speculatively load context "just in case". If the user says "read X", read X and
stop — do not also read related files unprompted. When coding, read only the specific
sections relevant to the current subtask, not entire large files upfront.

---

## Project Summary

A web application for running Pokémon-based tabletop RPG sessions. A Dungeon Master
sets up encounters and NPCs; players manage their own trainers, Pokémon, and items.
Battles are turn-based, multiplayer, and run in the browser via polling.

---

## Stack

- **Frontend:** React + Vite, TypeScript
- **Backend:** Express.js + Node.js, TypeScript
- **Database:** MongoDB + Mongoose (MongoDB Atlas)
- **Auth:** JWT (`jsonwebtoken` + `bcrypt`) — role stored on user document, token sent in Authorization header
- **UI:** shadcn/ui + Tailwind CSS — mobile-first, no animations
- **Drag & Drop:** dnd-kit (touch + mouse, used in /party and /pc)
- **Damage Calculation:** @smogon/calc (backend only, no external calls)
- **Battle Updates:** Polling every 2–3 seconds via GET /api/battle/:id/state (no WebSockets)
- **Hosting:** Vercel (frontend), Railway or Render (backend), MongoDB Atlas
- **Version Control:** GitHub (github.com/michaelhughes45/pokemonGame) — single monorepo, main branch only
- **Folder Structure:** `frontend/` (React + Vite), `backend/` (Express)

---

## Roles

| Role | Key Permissions |
|------|----------------|
| player | Own trainer, party, PC, bag; submit moves; catch Pokémon |
| dm | Everything player can do + create NPCs/encounters, award EXP, override evolutions, control battle state |
| admin | Everything DM can do + manage all accounts, roles, cache, data reset |

Role is stored as `role: 'player' | 'dm' | 'admin'` on the user document.
Auth guards live in Express middleware — verify JWT on every protected route, check role as needed.

---

## Key Decisions (do not change these without updating this file)

- **React + Express not Next.js** — user prefers explicit frontend/backend separation; frontend in `frontend/`, backend in `backend/`
- **Polling not WebSockets** — Vercel serverless incompatible with persistent connections
- **EVs/IVs deferred to Phase 5** — `evs` field exists on Pokémon document defaulting to all zeroes; `@smogon/calc` receives zeroes until Phase 5 activates the system. Battles run on base stats + nature + level until then.
- **Trainer Stat IV bonus also deferred** — stored on user document but not applied to `@smogon/calc` until Phase 5
- **All generations supported** — no gen cap on species, moves, or abilities
- **Esoteric moves flagged `implemented: false`** — fall back to basic damage + DM note in turn log. Cut list: Attract, Helping Hand, Baton Pass, Metronome, Transform, Sketch, Copycat, Me First, Counter, Mirror Coat, Metal Burst, Roar, Whirlwind, Dragon Tail, Trick Room, Magic Room, Wonder Room, Follow Me, Rage Powder, Wide Guard, Quick Guard, Heal Pulse, Aromatic Mist, Wrap, Bind, Fire Spin, Whirlpool, and all other binding/trapping moves
- **Abilities implemented on demand** — all gens cached from PokeAPI with `implemented: Boolean` flag; common ones first, others added as campaign needs them
- **Scoped item system** — only these categories supported:
  - `healing`: Potion, Super Potion, Hyper Potion, Max Potion, Full Restore, Revive, Max Revive, healing berries
  - `status_cure`: Antidote, Parlyz Heal, Burn Heal, Ice Heal, Awakening, Full Heal, status-curing berries
  - `pp_recovery`: Ether, Max Ether, Elixir, Max Elixir
  - `stat_booster`: HP Up, Protein, Iron, Calcium, Zinc, Carbos, PP Up, PP Max
  - `held_type`: Charcoal, Mystic Water, Magnet, Miracle Seed, Never-Melt Ice, Spell Tag, TwistedSpoon, Black Belt, Poison Barb, Soft Sand, Hard Stone, Silver Powder, Sharp Beak, Dragon Fang, Black Glasses, Silk Scarf, Metal Coat
  - `pokeballs`: all variants
  - `escape`: Escape Rope only (consumed out of battle, no mechanical effect until overworld added)
  - Everything else (X items, key items, contest items, mail, etc.) — NOT supported
- **Item pocket derived automatically** — `backend/src/lib/itemData.ts` maps every supported itemId to its pocket. DM give-item endpoint uses this; pocket is never specified by the client
- **TMs and HMs are identical (Gen 8+ style)** — unlimited uses, no mechanical distinction between TM and HM; both live in a `tm_hm` bag pocket; compatibility checked against PokeAPI `machine` learn method on the species cache; teaching replaces one of the Pokémon's 4 current moves (player picks which slot); deferred to milestone 5.8
- **Rare Candy implemented** — increments level by 1 (cap 100), currentHp rises by the same amount as maxHp increase (matches main games)
- **Flutes implemented** — `poke-flute`, `blue-flute`, `green-flute` cure sleep; `yellow-flute` cures confusion (volatile status)
- **levelUpMoves cached on species** — `PokedexCache` stores `levelUpMoves: [{ moveId, level }]` (minimum level across all game versions). DM give-pokemon and starter selection use this to assign the last 4 learnable moves at the target level. Old cache entries auto-refresh on next give-pokemon call
- **No-target moves skip the target picker** — `WEATHER_MOVES` and `SELF_TARGETING_MOVES` tables in `battles.ts` define moves that don't hit an opposing Pokémon. The state endpoint returns `noTargetMoveIds: string[]`; the frontend shows a "Use [Move]" button instead of the enemy picker. The backend accepts an empty `targets: []` array for these moves.
- **Weather move interaction rules** — using a weather move while the same weather is active: no effect. Using a weather move while a different weather is active: both cancel (weather clears to null). No active weather: sets the new weather for 5 turns.
- **`weatherTurnsRemaining` null vs number** — `null` means DM-set indefinite weather (no countdown); a number counts down each round and auto-clears at 0.
- **No terrain system** — weather only (rain, sun, sandstorm, hail, snow)
- **Physical board handles movement** — the app does not track position or adjacency. Players select targets manually; adjacency is self-reported from the physical table, not enforced by the app
- **Two-phase turn structure** — move_submission phase collects all actor moves first; targeting phase resolves them sequentially in speed order. This matches the physical miniatures flow where intent is declared before targets are chosen
- **Targeting is free-form** — players select any subset of Pokémon in the battle as targets. No targeting-type enforcement (single/adjacent/AoE) — the physical table and player judgment handle that
- **Moves resolve immediately on target selection** — each actor picks targets then @smogon/calc runs right away; resolution is sequential (speed order), not all-at-once
- **Status damage is end-of-round** — burn, poison, toxic ticks apply after all moves in the round have resolved, not mid-turn
- **DM submits for all NPCs** — players submit their own moves; DM handles enemy side entirely
- **Battle format is type + size, not a fixed enum** — `type` describes who the sides are (`pve`, `wild`, `pvp`); matchup size (1v1, 3v5, 6v6, etc.) is derived from the lengths of `playerSide` and `enemySide`. Supports any lopsided or symmetric matchup without schema changes
- **Campaigns group a DM and their players** — all DM actions (give Pokémon, give item, view party, create encounters) are scoped to players in the DM's campaign. A DM cannot modify players outside their own campaign. DMs invite players by username; players accept/decline on their dashboard
- **One active campaign per user** — a player must leave their current campaign before joining another. Trainer, Pokémon, and items are global to the user (not scoped per campaign). DMs run one campaign; their role does not include a player character
- **Encounters, NPCs, and battles belong to a campaign** — all have a `campaignId` field; DMs can only see/edit their own campaign's data
- **No hard party size caps** — player party and NPC party are unbounded. Prior caps (6 for players, 12 for NPCs) are removed; the DM can build any battle size they need.
- **NPC enemy slot count is DM-controlled** — `encounter.enemies[].slotCount` sets how many simultaneous active slots that NPC gets in the battle. `null` = match `playerIds.length` at launch time (original behaviour, fully backwards-compatible). Allows lopsided matchups (e.g. 3 players vs 7 NPC slots) without changing player-side logic.
- **Player Pokémon limit is per-battle, set by DM on the encounter** — `playerPokemonLimit` (null = no limit). Tracks distinct Pokémon sent out via `usedPokemonIds` on each player's `playerSide` entry. No pre-selection — players pick freely up to the limit during the battle. If all used Pokémon faint, that player is out for the rest of the battle
- **Starters begin at level 1** — any species is valid as a starter; DM/admin can reset a player's starter via DELETE /api/dm/players/:username/starter
- **Exp. Share is always on (Gen 6+ style)** — all Pokémon in the party gain EXP after battle; active battlers receive full EXP, benched Pokémon receive half EXP. No toggle.
- **No PvP until Phase 5**
- **No animations** — shadcn/ui CSS transitions only, no Framer Motion
- **PC storage is a flat list** — no box grid system
- **Pokédex shows only encountered species** — fetch-on-demand from PokeAPI, cached to MongoDB on first view

---

## GitHub Workflow

**Repo:** github.com/michaelhughes45/pokemonGame (single monorepo, main branch only)

### Branching strategy
Push directly to `main`. No feature branches. Use **git tags** to mark every completed
milestone — tags are the rollback points and the project history.

### Tag naming convention
```
v1.1   — milestone 1.1 complete (project setup)
v1.2   — milestone 1.2 complete (auth)
v2.3   — milestone 2.3 complete (pokémon detail)
v3.11  — milestone 3.11 complete (NPC AI — first playable game)
v4.2   — milestone 4.2 complete (group battles — first real session)
```

### End-of-milestone git routine
Run these commands at the end of every milestone before closing your session:
```bash
git add .
git commit -m "milestone X.X: [short description of what was built]"
git tag vX.X -m "milestone X.X complete — [done-when description]"
git push origin main
git push origin vX.X
```

### Example commit messages
```
git commit -m "milestone 1.1: project scaffolding, Next.js + TS, MongoDB, shadcn/ui"
git commit -m "milestone 2.2: starter selection wizard, Trainer Stat picker"
git commit -m "milestone 3.4: turn resolution with @smogon/calc, HP updates in MongoDB"
git commit -m "milestone 3.11: NPC AI, full solo 1v1 battle playable end-to-end"
```

### Rolling back to a milestone
```bash
git checkout v2.3        # inspect the state at milestone 2.3
git checkout main        # return to current state
git reset --hard v2.3   # ⚠ destructive — only if you need to fully revert
```

### Vercel + GitHub integration
Connect the GitHub repo to Vercel once during milestone 1.1 setup.
Every push to `main` auto-deploys to your Vercel preview URL.
This means after every milestone commit, a live deployed version exists automatically.

### .gitignore essentials
Make sure these are ignored from day one:
```
node_modules/
.env
```

### Environment variables
Never commit secrets. Store backend vars in Railway/Render dashboard + local `backend/.env`:
```
MONGODB_URI=
JWT_SECRET=
PORT=
FRONTEND_URL=
```
Store frontend vars in Vercel dashboard + local `frontend/.env`:
```
VITE_API_URL=
```

---

## MongoDB Collections

### `users`
```
_id, username, email, passwordHash, role, trainerStats (Map<String,Number> e.g. {speed:20}),
trainerStatChoice (String), badges ([]), money (Number), currentCampaignId (ObjectId | null), createdAt, updatedAt
```
`trainerStats` is a flexible key-value map — new homebrew stats slot in without schema migration.

### `campaigns`
```
_id, name, dmId (ObjectId→user), playerIds ([ObjectId→user]),
pendingInvites ([{ userId, sentAt }]),
isActive (Boolean), createdAt
```
DM creates the campaign and invites players by username. Players see pending invites on their
dashboard and accept or decline. On accept, the player's `currentCampaignId` is set and they
are added to `playerIds`. One active campaign per user at a time — a player must leave their
current campaign before joining another.

### `pokemon`
```
_id, speciesId (PokeAPI national dex ID), ownerId, ownerType ('player'|'npc'|'wild'),
nickname, level, exp, currentHp, nature, gender, heldItem,
moves ([{ moveId, currentPP, maxPP }] max 4),
evs ({ hp:0, atk:0, def:0, spatk:0, spdef:0, speed:0 } — zeroes until Phase 5),
statusCondition (null|'burn'|'paralysis'|'sleep'|'freeze'|'poison'|'toxic'),
statusCounter (Number | null) — sleep turns remaining (1–3 on inflict) and toxic damage scaling counter (increments each round),
volatileStatus ([{ condition, turnsRemaining }]),
evolutionOverrides ([{ condition, value }]),
isInParty (Boolean), partySlot (1–6 or null),
caughtAt, caughtByPlayerId, createdAt
```

### `battles`
```
_id (used as poll key), campaignId (ObjectId), type ('pve'|'wild'|'pvp') — who the sides are; actual matchup size is derived from playerSide/enemySide lengths,
status ('waiting'|'active'|'complete'),
phase ('move_submission'|'targeting'|'end_of_round') — sub-state within 'active',
playerSide ([{ userId, activePokemonId, usedPokemonIds:[], fainted:[] }]),
enemySide ([{ npcId (absent for wild), activePokemonId, fainted:[] }]),
turnNumber,
turnQueue ([{
  actorId (userId or npcId or activePokemonId for wild),
  actorType ('player'|'npc'),
  activePokemonId,
  actionType ('move'|'item'|'switch'|'catch'|'run'),
  moveId, itemId, switchToPokemonId,
  targets ([pokemonId]) — empty [] during move_submission, filled during targeting phase,
  resolved (Boolean)
}]),
currentTargetIndex (Number) — index into speed-sorted turnQueue for targeting prompts,
weather (null|'rain'|'sun'|'sandstorm'|'hail'|'snow'),
weatherTurnsRemaining (Number | null),
fieldConditions ([{ condition, turnsRemaining }]),
turnLog ([{ turn, events:[] }]),
catchAttempts ([{ playerId, pokemonId, result }]),
playerPokemonLimit (Number | null) — max distinct Pokémon each player may send out; null means no limit (use full party of 6),
wildCatchable (Boolean) — false lets DM use wild Pokémon as a pure fight,
expAwarded (Boolean), encounterId, lastUpdatedAt, createdAt, endedAt
```

### `encounters`
```
_id, campaignId (ObjectId), createdByDm (ObjectId→user), title, type ('pve'|'wild'),
enemies ([{ npcId (ObjectId→npc), slotCount (Number|null) }]) — PvE only; slotCount sets how many enemySide slots this NPC gets (null = match player count at launch),
wildPokemon ([{ speciesId, level, catchable (Boolean) }]) — Wild only; each entry generates one live Pokémon doc on launch,
playerPokemonLimit (Number | null), npcPokemonLimit (Number | null),
expMultiplier (Number, default 1), notes (String), isActive (Boolean)
```

### `npcs`
```
_id, campaignId (ObjectId), createdByDm, name, type ('trainer'|'wild'), party ([ObjectId→pokemon], max 12),
aiStrategy ('random'|'optimal'|'defensive'|'custom'), customAiNotes,
trainerClass, dialogueBefore, dialogueAfter
```

### `items`
```
_id, ownerId, ownerType ('player'|'npc'), itemId (PokeAPI slug), quantity,
pocket ('healing'|'status_cure'|'pp_recovery'|'stat_booster'|'held_type'|'pokeballs'|'escape')
```
Unique index on (ownerId, itemId) — one stack per owner per item. `ownerType` distinguishes
player bags from NPC bags; `ownerId` refs User for players, Npc for NPCs. Pocket is derived
server-side via getPocket(itemId) — never specified by the client.

### `pokedex_cache`
```
_id, pokeApiId, name, types ([]), baseStats ({ hp,atk,def,spatk,spdef,speed }),
abilities ([{ name, isHidden, effect, implemented:Boolean }]),
moves ([{ name, type, category, power, accuracy, pp, priority, effect, implemented:Boolean }]),
levelUpMoves ([{ moveId, level }]) — min level across all game versions, sorted ascending,
evolutionChain ([{ speciesId, condition, value }]),
evYield ({ hp,atk,def,spatk,spdef,speed }),
catchRate, expGroup, genderRatio, isLegendary, isMythical, cachedAt
```
Fetched from PokeAPI on first encounter, served from MongoDB cache thereafter.
Old entries missing `levelUpMoves` are auto-refreshed on next DM give-pokemon call.

---

## Pokémon Data Source

**PokeAPI** (pokeapi.co) — fetch on demand, cache to `pokedex_cache`.
Never bulk-seed everything upfront. Fetch when a species is first encountered in the game.
Admin panel has a manual refresh button per entry.

---

## Damage Calculation

**@smogon/calc** — installed via `npm install @smogon/calc`.
- Runs server-side only during turn resolution
- No external network calls — pure calculation library
- Pass `evs: {hp:0,atk:0,...}` until Phase 5 activates EVs
- Pass Trainer Stat IV bonus as zero until Phase 5 activates it
- Handles: full damage formula, type chart (all gens), STAB, weather, abilities,
  held item modifiers, nature, critical hits automatically

---

## Battle Polling Flow

Movement and positioning are handled on a physical table with miniatures. The app resolves
damage, status effects, HP, PP, and turn order only — it does not track board position.

### Round flow

1. **DM launches encounter** → battle document created, `status: 'active'`, `phase: 'move_submission'`
2. **Players navigate to `/battle/[id]`** — client polls `/api/battle/[id]/state` every 2–3s
3. **Move submission phase** — each player POSTs their move choice (no target yet); DM submits for all NPCs.
   Round does not advance until every actor has submitted.
4. **Server sorts by speed** → builds speed-ordered `turnQueue`, sets `phase: 'targeting'`, `currentTargetIndex: 0`
5. **Targeting phase (sequential)** — poll response indicates whose turn it is to pick targets.
   The active actor selects which Pokémon their move hits (they know adjacency from the physical table).
   Player POSTs target selection → server resolves move immediately (`@smogon/calc` runs, HP updates) →
   `currentTargetIndex` increments → next actor is prompted.
6. **End of round** — after all moves resolve, server applies end-of-round status damage
   (burn, poison, toxic ticks, etc.), sets `phase: 'move_submission'` for next round.
7. **Battle document updated** in MongoDB with new state + `lastUpdatedAt` bumped each step.
8. **Battle ends** when one side is fully fainted → EXP distributed to full party (Gen 6+ style), evolution checked.

---

## Mobile-First Rules

- Write unprefixed Tailwind classes for mobile layout FIRST
- Add `md:` and `lg:` prefixes for desktop enhancements
- All touch targets minimum 44×44px (`min-h-[44px] min-w-[44px]`)
- No hover-only interactions — everything reachable by tap
- Navigation: fixed bottom tab bar on mobile → left sidebar on `md:`
- shadcn/ui Sheet component for bottom drawers (battle actions, item use, PC swap)

---

## Folder Structure

```
pokemonGame/
  frontend/                  ← React + Vite + TypeScript
    src/
      components/ui/         ← shadcn/ui components
      lib/                   ← utilities (e.g. utils.ts from shadcn)
      hooks/                 ← custom React hooks
      pages/                 ← page-level components (not file-based routing)
      index.css              ← Tailwind v4 + shadcn theme variables
      main.tsx
      App.tsx
    .env                     ← VITE_API_URL=http://localhost:4000
  backend/                   ← Express + TypeScript
    src/
      lib/
        db.ts                ← MongoDB connection (connectDB)
        statCalc.ts          ← computeStats (Gen 3+ formula) — shared utility
        itemData.ts          ← getPocket(itemId) lookup table — itemId → ItemPocket
        pokeapi.ts           ← fetchSpecies (PokeAPI fetch + transform)
      middleware/            ← auth middleware (JWT verify)
      models/                ← Mongoose models (User, Pokemon, Item, PokedexCache)
      routes/                ← Express routers (auth, pokemon, items, starter, dm, admin, pokedex)
      index.ts               ← app entry point, port 4000
    .env                     ← MONGODB_URI, JWT_SECRET, PORT, FRONTEND_URL
  .gitignore
  CLAUDE_CONTEXT.md
```

---

## Conventions Established

- All Mongoose models use `.lean()` for read-only queries
- All API routes return `{ data, error }` shape — `data` is null on error, `error` is null on success
- Mongoose models use `type` aliases (not `interface extends Document`) — modern Mongoose infers types from schema
- `verifyToken` middleware attaches `{ userId, role }` to `req.user` via Express global declaration merging
- Auth errors for invalid email vs wrong password both return `'Invalid credentials'` (deliberately vague to prevent account enumeration)
- Mongoose DocumentArray vs plain array TS conflicts: cast to explicit local types after `.lean()` (e.g. `const entries = (doc.field ?? []) as MyType[]`) rather than fighting Mongoose's inferred generics
- Stat formula extracted to `backend/src/lib/statCalc.ts` — import `computeStats` from there, do not duplicate it in route files
- Item effects live in `backend/src/routes/items.ts` (ITEM_EFFECTS table); item→pocket mapping lives in `backend/src/lib/itemData.ts` (getPocket)
- Move classification tables in `battles.ts`: `STATUS_MOVES` (status-inflicting), `WEATHER_MOVES` (field weather), `SELF_TARGETING_MOVES` (no enemy target), `NO_TARGET_MOVE_IDS` (union of weather + self — sent to client via state endpoint)
- `applyEndOfRound` uses a `runningHp` map so stacked damage sources (e.g. burn + sandstorm on the same Pokémon) each read from the updated HP rather than the original snapshot
- `checkConfusion` always emits a leading `"[Name] is confused..."` event before the outcome (self-hit or move proceeds), so the turn log narrates the full sequence
- Item actions in battle use the same `POST /api/battles/:id/submit-move` endpoint with `{ actionType: 'item', itemId, targetPokemonId }` — the backend branches on `actionType`
- Item actions are pre-sorted before all moves (`actionType === 'item'` wins the sort in `checkAndAdvance`) matching main-game trainer-acts-first priority
- Item actions auto-resolve in `autoSkipBlockedActors` without client input (target is pre-filled at submission time); `BATTLE_ITEM_EFFECTS` table in `battles.ts` mirrors the healing/status_cure entries from `items.ts`
- Items are only deducted from the bag on a successful use (wrong-status items log "no effect" but are not consumed)
- Volatile statuses (confusion) are cleared when a Pokémon is swapped out (`send-out`, `dm-send-out`, `resolveSwitch`) and also when a Pokémon faints (`applyFaints`)
- Switch actions use the same `POST /api/battles/:id/submit-move` endpoint with `{ actionType: 'switch', switchToPokemonId }`; the target is pre-filled so switches auto-resolve in `autoSkipBlockedActors` like items do
- Priority tiers in `checkAndAdvance` sort: items (2) → switches (1) → moves (0); within each tier speed order applies
- `usedPokemonIds` on each `playerSide` entry tracks distinct Pokémon sent into the battle. Switching back to a previously-used Pokémon is always free; only introducing a brand-new Pokémon costs a slot against `playerPokemonLimit`
- State endpoint returns `usedPokemonCount` (derived from `usedPokemonIds.length`) and `pokemonLimitReached` (computed boolean) per player entry so the frontend does not need to recompute them
- `applyFaints` runs after every move resolution (submit-target) and after end-of-round damage (applyEndOfRound) — never inline; always call the helper to ensure volatile status is cleared and `fainted[]` is updated consistently
- `canEvolve` in `backend/src/lib/evolution.ts` handles only `condition === 'level-up'`; item/trade evolutions are explicit player actions deferred to later phases
- `expForLevel(level, expGroup)` in `statCalc.ts` returns total accumulated EXP needed to reach a level; the six PokeAPI group names are: `slow`, `medium-fast`, `fast`, `medium-slow`, `slow-then-very-fast` (erratic), `fast-then-very-slow` (fluctuating); `medium` is treated as an alias for `medium-fast`
- `distributeExp` now uses `$set` (not `$inc`) for EXP because it computes the exact final `exp`, `level`, `currentHp`, and `speciesId` in one pass — avoids any race condition and keeps the update atomic
- DM evolution override convention: `{ condition: 'prevent', value: '' }` pushed to `evolutionOverrides` blocks all level-up evolution for that Pokémon; POST/DELETE `/api/dm/pokemon/:pokemonId/evolution-override` manage it; `assertDmOwnsPokemon` guard verifies campaign membership before allowing the action
- `npcPokemonLimit` on Battle is independent of `playerPokemonLimit` — the DM sets it separately when creating a battle; null = all NPC Pokémon must faint; when set, `checkBattleEnd` uses `entry.fainted.length >= npcPokemonLimit` per NPC entry
- Heal endpoints restore `currentHp` to computed `maxHp`, set `statusCondition`/`statusCounter`/`volatileStatus` to null/[], and restore all `moves[].currentPP` to `maxPP`; batch species lookup (one PokedexCache query for all unique speciesIds) before parallel `updateOne` calls
- `checkBattleEnd` guards on `battle.status !== 'active'` so it is safe to call multiple times per round without double-triggering; enemy side checks live NPC party HP in the DB; player side checks sendable party Pokémon per-entry
- `distributeExp` uses `expAwarded` flag to prevent double-awarding; simplified formula `enemy_level × 5` per fainted enemy is a Phase 5 placeholder; active battlers (`usedPokemonIds`) get full EXP, benched get half with "(Exp. Share)" label in the turn log
- `autoSkipBlockedActors` checks HP ≤ 0 on move actors before the status-block check — a Pokémon fainted by a faster actor is skipped rather than prompted for target selection
- Wild battles: `enemySide` entry has no `npcId` (undefined/null); wild Pokémon created with `ownerType: 'wild'` at battle creation with random nature, gender, and last-4 level-up moves; `actorId` for the wild side is `activePokemonId` (not an npcId); DM chooses species via `/api/pokedex/:idOrName` lookup or clicks "Random" to pick a random species (1–1025)
- `GET /api/pokedex/search?q=` route (≥2 chars) searches PokedexCache by name regex, returns up to 10 matches — used by DM species lookup in CreateBattleCard
- Catch formula: `catchValue = min(255, floor(catchRate × ballMod × hpModifier × statusMod))`; 3 shake checks each at probability `catchValue/255`; master-ball bypasses all checks; `BALL_MODIFIERS` table in battles.ts; `statusCatchModifier` helper (sleep/freeze → 2.5×, par/burn/pois/tox → 1.5×); success transfers Pokémon ownership to player PC (ownerType:'player', caughtByPlayerId set), ball consumed, `catchAttempts` logged, wild activePokemonId nulled; catch auto-targets the wild Pokémon at submission — no targetPokemonId needed from the client
- `wildCatchable` flag on Battle (true by default) controls whether the Ball tab and catch submission are available; DM can set it false to use wild encounters as pure fight encounters
- Run action: `actionType: 'run'` submits with no additional fields; auto-resolves in `autoSkipBlockedActors` at priority tier 0 (speed order, same as moves); logs "[Name] dashes away to reposition!" to the turn log; no state changes — purely a physical-table repositioning signal
- Priority tiers in `checkAndAdvance` sort updated: items/catch (2) → switches (1) → moves/run (0); within each tier speed order applies
- Ball tab in BattlePage: shown only when `battle.type === 'wild' && battle.wildCatchable`; displays pokeball-pocket bag items; clicking one calls `handleSubmitCatch(itemId)`; pokeballs are now included in the bagItems fetch filter alongside healing + status_cure
- Run button in BattlePage: shown for all wild battles below the action tabs; requires a two-step confirm (`Run` → `Confirm Run` + `Cancel`) before submitting; resets each new round with other action state
- `hasHiddenAbility: Boolean` (default false) on Pokemon model; PATCH `/api/dm/pokemon/:id/hidden-ability` toggles it; `resolveMove` picks the hidden ability slot when true, falls back to slot 1 if species has none; DM-only toggle button in Abilities card (purple when active, hidden when species has no hidden ability)
- `statStages` on Battle is `Schema.Types.Mixed` (not a Mongoose Map) — always call `battle.markModified('statStages')` after any mutation; keyed by `pokemonId.toString()`; deleted (not zeroed) on switch-out and faint
- `STAT_STAGE_MOVES` covers self-boost moves (in `SELF_TARGETING_MOVES`) and opponent-debuff moves (go through `resolveMove` path); `applyStatStageEffects` is the single helper for both; stat stage boosts passed to `@smogon/calc` as `boosts: { atk, def, spa, spd, spe }` (acc/eva stored but not passed — not used in damage formula)
- Self-targeting branch in submit-target fetches `'nickname speciesId currentHp nature level volatileStatus'` from Pokemon and `'name baseStats'` from PokedexCache
- Recovery move `Rest` sets `statusCondition: 'sleep'` and `statusCounter: 2` directly — slots into the existing Gen 5+ sleep counter system in `checkStatusBlock` without extra changes
- Recoil/drain moves pre-fetch the attacker once before the target loop (not per-target) to avoid redundant DB hits; `atkSnap.currentHp` updated in-place after each application so multi-target edge cases stay consistent
- `RECOIL_MOVES` has two types: `'damage'` (fraction of damage dealt) and `'max-hp'` (fraction of attacker's own maxHp — used by Struggle only); minimum 1 recoil enforced; only fires when `damage > 0` (misses don't trigger recoil)
- `buildInfo` in state endpoint now returns `statStages: StatStages | null` per active Pokémon (null when no stages set); `StatStageBadges` component in BattlePage shows green `+N` / red `−N` pills for each non-zero stage
- `MULTI_HIT_MOVES` table in `battles.ts`: `{ type: 'fixed', count: N }` or `{ type: 'variable' }`; `getHitCount(moveId)` helper returns 1 for non-multi-hit moves, N for fixed, or `[2,2,3,3,4,5][random]` for variable (Gen 5+ distribution); hit loop breaks early if target faints mid-sequence; `targetHpMap` updated after each hit so subsequent hits check real HP; PP deducted once outside the loop; recoil/drain accumulate `totalDamage` across all hits
- `StatEffect` has an optional `chance?: number` field (default 1 = guaranteed); `STAT_STAGE_MOVES` now covers damaging moves with secondary stat effects — guaranteed self-drops (Close Combat, Overheat, Draco Meteor, etc.), chance-based foe drops (Crunch 20%, Psychic 10%, etc.), and chance-based self boosts (Charge Beam 70%, Meteor Mash 20%); foe effects in the damage path are chance-rolled per effect; self effects on damaging moves apply in the damage path using `atkSnap` (pre-fetched when `selfStatEffects.length > 0`)
- `applyEntryAbilities(battle, incomingId, incomingSide)` fires on every field entry — called from `send-out`, `dm-send-out`, and `resolveSwitch`; handles Intimidate (−1 Atk to all active opponents via `applyStatStageEffects`) and weather-setting abilities (Drought/Drizzle/Sand Stream/Snow Warning, same cancel rules as weather moves, `weatherTurnsRemaining = null` for indefinite); events written to turn log in send-out/dm-send-out, returned as strings from resolveSwitch
- Two-turn moves: `CHARGE_MOVES` set + `CHARGE_MESSAGES` table in `battles.ts`; charge state stored as `volatileStatus: { condition: 'charging-<moveId>', turnsRemaining: 99 }` — pushed on turn 1, `$pull`ed on turn 2; `applyEffects` boolean gates stat boosts and recovery to turn 2 only; PP deducted normally on both turns; set includes geomancy, solar-beam, fly, dig, dive, bounce, sky-attack; Solar Beam skips charge when `battle.weather === 'sun'` (`skipCharge` flag, no volatile changes); `SEMI_INVULNERABLE_MOVES` set (fly/dig/dive/bounce/sky-attack) pushes an additional `{ condition: 'semi-invulnerable', turnsRemaining: 99 }` volatile on charge turn for DM awareness, pulled alongside the charge condition on turn 2
- Dream Eater: guard at top of the target loop (`continue` to next target if `statusCondition !== 'sleep'`), preventing damage, heal, and drain; logs "[Name] had no effect" instead
- Roost: after HP is restored, pushes `{ condition: 'roosting', turnsRemaining: 0 }` to `volatileStatus`; `applyEndOfRound` builds `effectiveTypes` by filtering 'flying' out when roosting before checking sandstorm/hail immunity; roosting volatile cleared from all active Pokémon at end of `applyEndOfRound` (lasts exactly one end-of-round check)
- `MOVE_PRIORITY` table in `battles.ts` — static record of all non-zero priority move slugs (e.g. `'quick-attack': 1`, `'extreme-speed': 2`, `'roar': -4`); zero-priority moves are absent (default 0); `checkAndAdvance` sort is now 3-tier: action type → move priority → speed
- `FLINCH_MOVES` table in `battles.ts` — maps move slug to flinch chance (0–1); flinch rolled once per target after all hits resolve, only when `totalDamage > 0`; sets `flinched = true` on the target's unresolved queue entry; `flinched?: boolean` on `TurnQueueEntry` (optional, Mongoose default false); `autoSkipBlockedActors` checks flinch after HP check and before status check — logs "[Name] flinched and couldn't move!" and auto-resolves the entry; the `!e.resolved` guard on the queue entry lookup enforces the speed rule (only faster attackers can flinch)
- Aurora Beam corrected: removed from `STATUS_MOVES` (was incorrectly freeze 10%), added to `STAT_STAGE_MOVES` as `[{ stat: 'atk', stages: -1, target: 'foe', chance: 0.1 }]`
- `NATURES` array exported from `statCalc.ts` — import from there in any route that needs to assign a random nature (battles.ts and dm.ts); do not re-declare it inline
- Encounter launch flow: PvE → for each NPC in `encounter.enemies`, creates `enemy.slotCount ?? playerIds.length` slots in `enemySide` (all same npcId, activePokemonId: null); Wild → generates one live Pokémon doc per `wildPokemon` entry, pushes to `enemySide` with no npcId; `playerPokemonLimit`, `npcPokemonLimit`, `encounterId` all carried from encounter to battle on launch
- DM send-out for multi-slot NPC battles: `POST /api/battles/:id/dm-send-out` accepts optional `slotIndex` (0-based, default 0) to target the nth slot for the given npcId; backend finds `battle.enemySide.filter(e => e.npcId === npcId)[slotIndex]`
- DM move submission for multi-slot: `POST /api/battles/:id/dm-submit-move` accepts optional `activePokemonId` to scope the "already submitted" check to a specific NPC slot; `resolveSwitch` matches NPC entries by BOTH `npcId` AND `activePokemonId` to handle multiple slots per NPC
- Frontend NPC slot key convention: `"${npcId}:${slotIndex}"` (e.g. `"abc123:0"`, `"abc123:1"`) used as key in `expandedSendOut` and `npcActionTab` state to track per-slot UI state independently; `fetchNpcParty(npcId, slotKey)` caches party by npcId but opens the correct slot's picker
- Multi-wild catch targeting: `POST /api/battles/:id/submit-move` with `actionType: 'catch'` accepts optional `targetPokemonId`; if omitted, falls back to the first live wild entry (backwards-compatible with single-wild battles)
- Ball tab multi-wild UI: `catchableWild` (active wild entries) and `isMultiWild` (length > 1) derived from battle state; target picker shown above ball list when `isMultiWild`; ball buttons disabled until target selected; `catchTarget` state resets on successful catch submission
- `resolveAbilitySlug(abilities, hasHiddenAbility)` helper in `battles.ts` — single source of truth for picking active ability slug from a species cache; returns null if no abilities cached; use it everywhere ability slug is needed instead of the inline find pattern
- `CachedAbility` type (`{ name: string; isHidden: boolean }`) is exported from `lib/battleCalc.ts` — single definition, import it wherever the type is needed; do not re-declare it inline
- `appendToLog(battle, ...events)` helper in `battles.ts` — finds or creates the turn-log entry for `battle.turnNumber`, appends all passed strings, and calls `battle.markModified('turnLog')`; no-ops when called with zero events; use this everywhere instead of the inline get-or-create-push-markModified pattern
- DM-only routes in `battles.ts` use `requireDm` as per-route middleware (e.g. `router.post('/:id/start', requireDm, async ...)`) instead of an inline `if (role !== 'dm' && role !== 'admin')` check; mixed-use routes (like `submit-target`) still do the check inline since they serve both players and DMs
- `applyStatStageEffects` accepts optional `abilitySlug?` 5th param — Contrary negates the stage change, Simple doubles it before the ±6 clamp; all callers that apply foe-caused drops or self-changes should pass the receiver's resolved ability slug
- `resolveMove` returns `{ damage, isCrit, events }` — `isCrit` is true only when a crit landed and dealt damage; callers use it to trigger Anger Point and track `anyCrit` across hit loops
- `atkSnap`/`atkSnapCache` are now unconditionally pre-fetched at the top of the damaging-moves `else` block in submit-target — many ability checks need attacker data and the conditional was becoming unwieldy
- `applySwitchOutAbilities(pokemonId, outgoing, outCache, outName)` helper — called from both NPC and player recall branches in `resolveSwitch` after volatile/stat-stage clear; handles Natural Cure and Regenerator
- `PRANKSTER_MOVES` set — derived at module load from `STATUS_MOVES` (chance===1 entries only), non-charging `SELF_TARGETING_MOVES`, and `WEATHER_MOVES`; used in `checkAndAdvance` to add +1 move priority per entry
- `WEATHER_SPEED_DOUBLERS` table — maps ability slug to `string[]` of matching weather values; used in `checkAndAdvance` `withSpeed` map; ability is now resolved before speed so both Prankster and weather-doubler checks share one resolution
- `ILATE_MAP` table — maps -ilate ability slugs to output type string; used for fallback formula multiplier and narration; `@smogon/calc` handles the full type conversion and 1.2× when the ability is passed normally
- `STATUS_IMMUNITY_ABILITIES` table in `battles.ts` — maps ability slug to the status conditions it blocks (e.g. `'immunity': ['poison','toxic']`); checked in `applyStatusEffect` after type-immunity and in `checkConfusion` (Own Tempo/Oblivious snap out immediately if somehow confused); type-immunity is silent, ability-immunity logs a message
- `CONTACT_MOVES` set in `battles.ts` — physical moves that make contact; checked per-target after the hit loop when `totalDamage > 0`; triggers contact-based defender abilities on the attacker: Rough Skin/Iron Barbs (1/8 maxHp chip, always), Poison Point/Static/Flame Body (30% status), Effect Spore (30% → 1/3 each: poison/paralysis/sleep); status events routed through `applyStatusEffect` so attacker type/ability immunities apply for free; `atkSnap` pre-fetch condition extended to include `CONTACT_MOVES.has(moveId)` so Rough Skin/Iron Barbs can use the attacker's cached HP/stats
- End-of-round ability effects loop in `applyEndOfRound` runs after status and weather damage loops (reads `runningHp` for up-to-date HP); Poison Heal intercepts the status damage loop via `continue` before damage is computed; Speed Boost (+1 Spe) and Moody (+2 random / −1 different) use `applyStatStageEffects` + `battle.markModified('statStages')`; Rain Dish/Ice Body/Dry Skin heal use `runningHp` so they stack correctly with other end-of-round damage
- Swagger/Flatter: confusion already handled by `STATUS_MOVES`; foe stat boost (Atk +2 / SpA +1) added to `STAT_STAGE_MOVES` — both effects fire independently through their respective existing code paths
- Focus Energy: pushes `{ condition: 'focus-energy', turnsRemaining: 99 }` volatile in the self-targeting branch; `resolveMove` reads `attacker.volatileStatus` (already fetched) and uses `1/6` crit rate instead of `1/24` when the volatile is present
- Belly Drum: guard `curHp > floor(maxHp/2)` (fails if exactly at 50%); costs `floor(maxHp/2)` HP; hard-sets `stageMap[atkId].atk = 6` directly instead of going through `applyStatStageEffects` — Belly Drum ignores the ±6 clamp and always reaches maximum
- Endure: pushes `{ condition: 'enduring', turnsRemaining: 0 }` volatile; `targetPokemons` projection expanded to `'currentHp volatileStatus'`; `enduringTargets` set built from it before the target loop; damage block uses `rawNewHp ≤ 0 ? 1 : Math.max(0, rawNewHp)` clamp
- Pain Split: `continue` case at the top of the outer target loop (same pattern as Dream Eater); averages `floor((atkHp + tgtHp) / 2)`, both capped at their own `maxHp`; `atkSnap.currentHp` updated in-place so multi-target edge cases stay consistent
- Ingrain / Aqua Ring: push named volatiles in self-targeting branch; `applyEndOfRound` heals `1/16 maxHp` per round per volatile, reading `runningHp` so the heal stacks correctly with other same-round damage
- Leech Seed: `continue` case in the outer target loop; Grass-types immune (checked against PokedexCache `types`); pushes `{ condition: 'leech-seed', turnsRemaining: 99 }` on hit; `applyEndOfRound` drains `1/8 maxHp` from the seeded Pokémon and restores `min(drain, rMaxHp - rCurHp)` to the first opposing active Pokémon still alive — restore is capped so it never overheals
- Curse: `isGhostCurse` flag computed from `atkCache.types` (self-targeting branch projection expanded to include `'types'`); non-Ghost follows the normal `STAT_STAGE_MOVES` self-effects path (+1 Atk, +1 Def, −1 Spe); Ghost path skips `STAT_STAGE_MOVES` via `if (statEffects && !isGhostCurse)`, costs `floor(maxHp/2)` HP, auto-targets the first opposing active slot (no client target picker — Curse stays in `SELF_TARGETING_MOVES`), pushes `{ condition: 'cursed' }` volatile; `applyEndOfRound` deals `1/4 maxHp` damage to cursed Pokémon each round
- `PROTECT_VOLATILE` table in `lib/moveData.ts` maps each protect-family move to its volatile condition name (`'protecting'`, `'protecting-kings-shield'`, etc.); all six moves added to `SELF_TARGETING_MOVES`; self-targeting branch pushes `PROTECT_VOLATILE[moveId]` on use; `protectingTargets` Map built from `targetPokemons.volatileStatus` (same expanded projection as `enduringTargets`); hit loop checks `protectingTargets` BEFORE calling `resolveMove` — logs protection message, applies contact side-effects (King's Shield −2 Atk, Obstruct −2 Def, Spiky Shield 1/8 chip, Baneful Bunker poison), then `break`s the hit loop
- Single-turn volatile clearing loop in `applyEndOfRound` (replaces Roost-only loop): clears `roosting`, `enduring`, and all `protecting*` condition names in one `$pull { condition: { $in: toClear } }` operation per Pokémon
- `Item.ownerType` (`'player'|'npc'`, default `'player'`) distinguishes player bags from NPC bags; `ownerId` is a User ObjectId for players and an Npc ObjectId for NPCs — `ref: 'User'` removed from the schema since both collection types share the field
- NPC bag endpoints: `GET /api/dm/npcs/:npcId/bag` returns items with `ownerType:'npc'`; `POST /api/dm/npcs/:npcId/give-item` body `{ itemId, quantity? }` upserts with `$setOnInsert: { pocket, ownerType:'npc' }` — pocket derived automatically, same as player give-item
- `dm-submit-move` now accepts `actionType: 'item'` with `{ npcId, actionType:'item', itemId, targetPokemonId, activePokemonId? }`; validates item is in NPC bag, pushes to turnQueue with targets pre-filled — auto-resolves via existing `resolveItemAction` in `autoSkipBlockedActors`
- NPC action tab type is `'move' | 'switch' | 'item'`; Item tab lazy-loads the NPC bag via `fetchNpcBag(npcId)` on first open, shows only `healing` and `status_cure` items; click item to select → party picker appears → click target to submit
- `estimateDamage(attacker, attackerCache, attackerAbilitySlug, moveId, target, targetCache, targetAbilitySlug, weather)` — read-only @smogon/calc wrapper, returns average damage roll; returns 0 on any error; used by the `optimal` AI strategy
- `POST /api/battles/:id/dm-auto-submit` — DM-only; submits move choices for all unsubmitted NPC/wild slots using each NPC's `aiStrategy`; `random`=random move with PP>0; `defensive`=if HP<30% try healing item then Rest then random; `optimal`=highest average `estimateDamage` across all moves×targets; wild always random; targets left empty (targeting phase remains manual); "Auto NPCs" button in NPC Actions card header, disabled when all slots already submitted
- Party swap (`POST /api/pokemon/party/swap`) no longer enforces a party size cap — the "add" path (no `partyPokemonId`) always appends at `partyCount + 1`; DM give-pokemon always lands in party at next slot; wild catches always go to party at the first unused slot (found via `while (usedSlots.has(nextSlot)) nextSlot++`)
- `GET /api/dm/players/:username/roster` returns `{ party, pc }` arrays (party sorted by `partySlot`); each Pokémon enriched with `speciesName`, `maxHp`, `expForCurrentLevel`, `expForNextLevel` (null at level 100); guarded by `assertCampaignPlayer`
- `POST /api/dm/pokemon/:pokemonId/award-exp` body `{ exp: number }` — runs the identical level-up + evolution while-loop as `distributeExp`; returns `{ events, level, exp, speciesId }`; guarded by `assertDmOwnsPokemon`
- `POST /api/dm/pokemon/:pokemonId/level-up` — Rare Candy equivalent (single level increment, HP delta, evolution check); returns same `{ events, level, exp, speciesId }` shape; guarded by `assertDmOwnsPokemon`
- `PokemonCard` in `DmPlayersPage.tsx` accepts an optional `actions?: React.ReactNode` slot — HP bar + EXP progress bar are always shown; controls slot is filled by `ActionControls` in the same file; exported so it can be reused in future DM panels
- Forced re-fetch after mutation pattern: `const [rosterKey, setRosterKey] = useState(0)` + `const refreshRoster = () => setRosterKey(k => k+1)` added to `useEffect` deps — increment to trigger a re-fetch without changing the primary selector state

---

## Completed Milestones

- [x] **1.1** Project setup — repo, React+Vite frontend, Express backend, MongoDB, shadcn/ui, dnd-kit, env vars
- [x] **1.2** Auth — register, login, JWT session, role on user document
- [x] **1.3** Role guards — middleware, /dm/* and /admin/* protected
- [x] **1.4** Pokédex seed — fetch-on-demand from PokeAPI, cached to MongoDB
- [x] **2.1** Trainer profile — /dashboard with username, role, trainer stat specialty
- [x] **2.2** Starter selection — /starter wizard, Pokémon in party at level 1
- [x] **2.3** Pokémon detail — /pokemon/[id] with stats, moves, held item, evolution path
- [x] **2.4** Party management — /party with dnd-kit drag-to-reorder
- [x] **2.5** PC storage — /pc flat list, swap into party
- [x] **2.6** Bag & items — /bag with scoped categories, out-of-battle use, DM give-item, Rare Candy, flutes, level-based moveset on give-pokemon
- [x] **2.7** Move reminder — player can replace any of their Pokémon's current moves with any move learnable at or below its current level, via the Pokémon detail page. Also added Pokémon release (DELETE /api/pokemon/:id) with two-step confirmation; no one can release a trainer's last Pokémon (DM must use starter reset instead)
- [x] **2.8** Campaign system — DM creates campaign, invites players by username, players accept/decline on dashboard; all DM actions scoped to their campaign's players; one active campaign per user
- [x] **3.1** Battle document — Battle model, POST /api/battles (DM creates with campaign players), GET /api/battles/:id/state, blank battlefield UI at /battle/:id, CreateBattleCard on DM panel
- [x] **3.2** Polling loop — BattlePage polls /api/battles/:id/state every 3s (cancelled flag + interval cleanup on unmount); active battle surfaces on player dashboard via GET /api/battles/active; DM panel lists open battles via GET /api/battles/dm with links back into each battle
- [x] **3.3** Move submission phase — DM starts battle (waiting→active); players send out party Pokémon and submit move choice (no target yet); DM submits for NPCs; when all actors submitted, server speed-sorts turnQueue and advances phase to targeting; player side card shows Submitted/Pending badges per player
- [x] **3.4** Targeting phase + NPC management — POST /api/battles/:id/submit-target; speed-sorted turnQueue drives sequential targeting prompts; state endpoint enriched with activePokemonInfo (name, HP, maxHp) on both sides; Npc model + full CRUD (GET/POST /api/dm/npcs, POST /api/dm/npcs/:id/pokemon, GET /api/dm/npcs/:id/party); battle creation accepts npcIds; DM panel NpcCard + NPC checkboxes in CreateBattleCard; BattlePage DM NPC send-out + move submission UI; targeting card for players (pick targets) and DM (pick NPC targets); DELETE /api/battles/:id (DM only); bug fix: checkAndAdvance now requires all playerSide entries to have activePokemonId before advancing to targeting
- [x] **3.5** Turn resolution — @smogon/calc runs on target selection per actor (random damage roll, 1/24 crit rate, 1.5× crit multiplier, weather passed to calc, fallback formula if species/move unrecognised); end-of-round burn/poison/toxic damage (1/8 maxHp) applied after last actor resolves; PP deducted from attacker; phase parks at end_of_round awaiting DM
- [x] **3.6** Turn log + DM advance — events written to turnLog on each resolution; Battle Log card visible to all (most recent turn at top, older turns dimmed); end_of_round card shows DM an "Advance to Next Round" button and players a waiting message; POST /api/battles/:id/advance-round (DM only) clears turnQueue, increments turnNumber, resets to move_submission
- [x] **3.7** Status conditions — `STATUS_MOVES` table (~60 moves), `applyStatusEffect` with type immunity checks, `checkStatusBlock` (paralysis 25% skip, freeze 20% thaw, sleep counter-based Gen 5+ wake-on-wake-turn), `checkConfusion` (50% self-hit, typeless physical formula), `autoSkipBlockedActors` loop auto-resolves blocked actors without client input, toxic scales `counter/16 × maxHp` each round, burn/poison flat 1/8; `statusCounter` field added to Pokemon model; StatusBadge UI (BRN/PAR/SLP/FRZ/PSN/TOX/CNF) shown on move submission, targeting, and side cards; status blocking applies only to move execution (not full turn) to preserve future item-use hook; `checkConfusion` emits leading "is confused..." narration before outcome
- [x] **3.8** Weather — `weatherTurnsRemaining` field on Battle; `WEATHER_MOVES` table (sunny-day, rain-dance, sandstorm, hail, snowscape, chilly-reception) sets weather for 5 turns during turn resolution; same weather = no effect, different weather = both cancel; DM manual override via POST /api/battles/:id/weather (indefinite or countdown); sandstorm/hail deal 1/16 maxHp end-of-round to non-immune types (Rock/Steel/Ground immune to sand, Ice immune to hail); weather countdown auto-clears with flavor message; `SELF_TARGETING_MOVES` table covers stat boosts + recovery moves — no enemy target required, "Use [Move]" button shown instead of target picker; `noTargetMoveIds` returned in state endpoint; `runningHp` map fixes stacked end-of-round damage bug; WeatherBadge UI with colored pill + turn countdown
- [x] **3.9** Items in battle — `actionType: 'move' | 'item'` added to TurnQueueEntry; submit-move accepts item actions `{ actionType: 'item', itemId, targetPokemonId }`; item actions sort before all moves (trainer-acts-first priority); `BATTLE_ITEM_EFFECTS` table + `resolveItemAction` helper in battles.ts; items auto-resolve in `autoSkipBlockedActors`; bag deducted only on successful use; confusion cleared on swap-out (send-out + dm-send-out); Move/Item tab UI in BattlePage with two-step item → party-target picker
- [x] **3.10** Switching — `actionType: 'switch'` + `switchToPokemonId` added to TurnQueueEntry; submit-move accepts switch actions; switches sort between items (2) and moves (0) at priority tier 1; `resolveSwitch` recalls outgoing Pokémon (clears volatileStatus), sets new activePokemonId, updates usedPokemonIds; switches auto-resolve in `autoSkipBlockedActors`; playerPokemonLimit enforced at submission (new Pokémon blocked if limit reached, previously-used Pokémon always free); state endpoint returns `usedPokemonCount` + `pokemonLimitReached` per player; Switch tab UI in BattlePage with limit counter and per-Pokémon blocking; DM NPC switch support added (dm-submit-move accepts `actionType: 'switch'`; `resolveSwitch` handles both player and NPC sides)
- [x] **3.11** Faint & battle end — `applyFaints` helper detects HP ≤ 0 after every move and end-of-round damage, logs faint event, clears volatile statuses, updates `fainted[]` and nulls `activePokemonId`; `checkBattleEnd` checks full NPC party HP (enemy) and sendable party Pokémon (player) to set `status: 'complete'`; `distributeExp` awards EXP to all party Pokémon (active = full, benched = half via Exp. Share), guarded by `expAwarded` flag; Battle Complete banner + turn log visible on complete battles ★ first playable game
- [x] **4.1** Wild battles & catch — DM creates wild battles with species lookup or randomize (1–1025); wild Pokémon generated at battle creation (random nature, gender, last-4 level-up moves, computed HP via statCalc); `enemySide` entry has no npcId; catch formula (catchRate × ballMod × hpMod × statusMod, 3-shake check, master-ball bypass); success transfers Pokémon to player PC; `wildCatchable` flag; run action logs repositioning message in speed order; Ball tab + Run button (with confirm) added to player action UI
- [x] **4.2** Evolution engine — `canEvolve` helper in `backend/src/lib/evolution.ts` checks `evolutionChain` (condition === 'level-up') and respects `evolutionOverrides`; triggers on Rare Candy level-up (items.ts) and post-battle EXP (distributeExp in battles.ts); `expForLevel(level, expGroup)` added to statCalc.ts for all 6 Gen 3+ growth rates; level-up loop in distributeExp handles multi-level gains, HP delta, and evolution per level; DM override: POST/DELETE `/api/dm/pokemon/:id/evolution-override` sets/clears `{ condition: 'prevent' }` on the Pokémon; Pokémon detail page shows DM-only toggle button with yellow "blocked" state
- [x] **4.3** Town & NPC management — Pokémon Center (/town) heals player party (POST /api/pokemon/heal-party); DM heals NPC parties (POST /api/dm/npcs/:id/heal); NPC Party Manager on DM panel (load NPCs → select → party list with sprite + HP → links to /pokemon/:id); `npcPokemonLimit` field on Battle (independent of playerPokemonLimit, null = no limit, enforced in checkBattleEnd); Pokémart stub (Coming Soon)
- [x] **4.4** Core move effects — ability passed to @smogon/calc (first non-hidden slot; `hasHiddenAbility` Boolean on Pokemon + DM toggle PATCH `/api/dm/pokemon/:id/hidden-ability` + purple "Active" badge on detail page); stat stages (`StatStages` type exported from Battle.ts; `statStages: Schema.Types.Mixed` on Battle keyed by pokemonId.toString(); `STAT_STAGE_MOVES` table ~50 moves; `applyStatStageEffects` helper ±6 clamp with magnitude narration; boosts passed to @smogon/calc; cleared on switch-out and faint via `markModified('statStages')`; `StatStageBadges` green/red pill UI in BattlePage); recovery moves (`RECOVERY_MOVES` table — flat 50%, weather-scaled Synthesis/Moonlight/Morning Sun, Rest full-heal + sleep 2 turns); recoil moves (`RECOIL_MOVES` table — damage-fraction and max-hp types; attacker pre-fetched once before target loop); drain moves (`DRAIN_MOVES` table — 50% or 75% of damage restored to attacker; capped at maxHp)
- [x] **4.5** Advanced move effects — multi-hit moves (`MULTI_HIT_MOVES` table, fixed/variable, hit loop with early break on faint, total-damage recoil/drain); secondary stat effects on damaging moves (`StatEffect.chance?`, guaranteed self-drops + chance foe drops + chance self boosts added to `STAT_STAGE_MOVES`); switch-in ability effects (`applyEntryAbilities` — Intimidate −1 Atk, Drought/Drizzle/Sand Stream/Snow Warning set weather on entry); deferred 4.4 fixes: Dream Eater sleep guard, Geomancy two-turn charge (`CHARGE_MOVES`), Roost Flying-type removal (`'roosting'` volatile + `applyEndOfRound` effectiveTypes)
- [x] **4.6** Move mechanics completion — Aurora Beam fix (freeze → −1 Atk 10% foe drop); move priority (`MOVE_PRIORITY` table, 3-tier sort in `checkAndAdvance`); flinch (`FLINCH_MOVES` table, `flinched?` on TurnQueueEntry, rolled after damage, skipped in `autoSkipBlockedActors`); two-turn moves (Solar Beam with sun shortcut, Fly/Dig/Dive/Bounce/Sky Attack with `SEMI_INVULNERABLE_MOVES` volatile)
- [x] **4.7** DM encounter builder — Encounter model + CRUD (GET/POST/PUT/DELETE /api/dm/encounters); PvE launch: each NPC gets N enemy slots (N = player count) so each player faces one NPC Pokémon simultaneously; Wild launch: generates live Pokémon docs per wildPokemon entry; dm-send-out `slotIndex` param + dm-submit-move `activePokemonId` param scope actions per-slot; resolveSwitch matches NPC entries by npcId+activePokemonId; catch `targetPokemonId` for multi-wild targeting; EncountersPage (list, launch with player picker, delete); EncounterFormPage (create/edit, species lookup, NPC checkboxes, wild entries); BattlePage: multi-wild Ball tab target picker, NPC×N slot grouping in actions panel and enemy side card ★ first real session
- [x] **4.8** Ability engine — three categories of ability side-effects beyond `@smogon/calc` damage formula: (1) **Status immunity** — Immunity (poison), Insomnia/Vital Spirit (sleep), Magma Armor (freeze), Water Veil (burn), Limber (paralysis), Own Tempo (confusion), Oblivious (confusion); checked in `applyStatusEffect` and `checkConfusion` before applying; (2) **Contact abilities** — Poison Point (30% poison), Static (30% paralysis), Flame Body (30% burn), Rough Skin/Iron Barbs (1/8 maxHp recoil to attacker), Effect Spore (30% random: poison/paralysis/sleep); checked after damage resolves for each physical-contact hit; `CONTACT_MOVES` set to identify physical moves that make contact; (3) **End-of-turn abilities** — Speed Boost (+1 Spe per round), Rain Dish/Ice Body/Dry Skin (heal 1/16 in matching weather), Poison Heal (heal 1/8 when poisoned instead of taking damage), Moody (random +2/−1); applied in `applyEndOfRound` after status damage; pinch ability notifications (Torrent/Blaze/Overgrow/Swarm) already added in bug-fix session
- [x] **4.9** Extended ability engine — (1) **Contrary/Simple** — optional `abilitySlug?` param on `applyStatStageEffects`; Contrary negates the stage change, Simple doubles it; all 6 call sites (Intimidate, self/foe stat effects, end-of-round Speed Boost/Moody) pass the receiver's ability slug; (2) **Serene Grace & Prankster** — Serene Grace doubles `chance` at all three secondary-effect roll sites (status, foe stat drops, self stat changes on damaging moves); `PRANKSTER_MOVES` set derived from pure STATUS_MOVES + non-charging SELF_TARGETING_MOVES + WEATHER_MOVES; Prankster adds +1 to move priority in `checkAndAdvance` per-entry `movePriority` field; (3) **Natural Cure & Regenerator** — `applySwitchOutAbilities` helper fires on every switch-out (both NPC and player branches of `resolveSwitch`) after volatile/stage clear; Natural Cure clears statusCondition; Regenerator restores 1/3 maxHp; (4) **Weather speed doublers** — `WEATHER_SPEED_DOUBLERS` table (Swift Swim/rain, Chlorophyll/sun, Sand Rush/sandstorm, Slush Rush/hail+snow); ability resolved before speed in `checkAndAdvance` `withSpeed` map; ×2 multiplier applied to sort-time speed only after paralysis halve; (5) **Shed Skin** — 33% end-of-round status cure added to ability loop in `applyEndOfRound`; (6) **Moxie & Beast Boost** — checked at end of the damaging-moves `else` block after the target loop; `koCount` counts targets that reached HP ≤ 0; `atkSnap` reused if pre-fetched, else lazy-fetched; Beast Boost picks highest base stat among the 5 combat stats (HP excluded — no HP stage); boost fires once per KO; (7) **Competitive, Defiant, Anger Point** — Competitive/Defiant react to `foeEffects` with `stages < 0` in the damage loop and to Intimidate in `applyEntryAbilities`; `resolveMove` now returns `isCrit: boolean`; `anyCrit` flag tracked across the hit loop; Anger Point hard-sets Atk stage to +6 on any crit hit; (8) **Protean/Libero, -ilate abilities** — `ILATE_MAP` table (Pixilate→Fairy, Aerilate→Flying, Refrigerate→Ice, Galvanize→Electric); `@smogon/calc` already handles STAB/type conversion when ability is passed; fallback formula applies ×1.5 (Protean/Libero) or ×1.2 (ilate+Normal); move type fetched once before target loop via `$elemMatch` projection; narration fires per target before damage; `atkSnap`/`atkSnapCache` now unconditionally pre-fetched in the damaging-moves path
- [x] **4.10** `battles.ts` data extraction — 570 lines extracted into four new lib files: `lib/moveData.ts` (all 14 move tables + types + `getHitCount` + derived `NO_TARGET_MOVE_IDS`/`PRANKSTER_MOVES`); `lib/abilityData.ts` (`STATUS_IMMUNITY_ABILITIES`, `ILATE_MAP`, `PINCH_ABILITIES`, `WEATHER_SPEED_DOUBLERS`); `lib/weatherData.ts` (`WEATHER_MOVES`, `ENTRY_ABILITY_WEATHER`, `ENTRY_WEATHER_MESSAGES`); `lib/battleCalc.ts` (`GEN9`, `slugToDisplayName`, `toCalcWeather`, `toCalcStatus`, `resolveAbilitySlug`, `applyStatStageEffects`); `BATTLE_ITEM_EFFECTS`/`BALL_MODIFIERS`/`statusCatchModifier` merged into existing `lib/itemData.ts`; `battles.ts` reduced from 3,924 → 3,354 lines
- [x] **4.11** `battles.ts` consolidation — `appendToLog(battle, ...events)` helper replaces 15 inline get-or-create-push-markModified blocks; `CachedAbility` promoted to single `export type` in `lib/battleCalc.ts` (13 inline re-declarations removed); 6 DM-only routes in `battles.ts` converted to `requireDm` per-route middleware; dead inline role check + redundant `verifyToken` removed from `admin.ts`
- [x] **4.12** Move effect completion — (1) **Swagger/Flatter** — foe stat boost (Atk +2 / SpA +1) added to `STAT_STAGE_MOVES`; (2) **Focus Energy** — `'focus-energy'` volatile; crit rate in `resolveMove` rises to `1/6`; (3) **Endure** — `'enduring'` volatile; HP clamped to 1 instead of 0; (4) **Belly Drum** — HP guard + cost, Atk stage hard-set to +6; (5) **Pain Split** — HP averaging, both sides capped at maxHp; (6) **Ingrain / Aqua Ring** — named volatiles; heal 1/16 maxHp per round in `applyEndOfRound`; (7) **Leech Seed** — Grass-immune; `'leech-seed'` volatile; drain 1/8 + restore to opposing active in `applyEndOfRound`; (8) **Curse** — non-Ghost: +1/+1/−1 stat stages via `STAT_STAGE_MOVES`; Ghost: `isGhostCurse` type-check, HP cost, auto-curses first opposing active, `'cursed'` volatile deals 1/4 maxHp per round; (9) **Protect family** — `PROTECT_VOLATILE` table; `protectingTargets` Map; hit loop checks before `resolveMove`, applies contact side-effects (King's Shield −2 Atk, Obstruct −2 Def, Spiky Shield chip, Baneful Bunker poison); single-turn volatile clear loop in `applyEndOfRound` consolidates Roost + Endure + Protect*; Substitute deferred
- [x] **4.13** NPC battle enhancements — (a) removed player party cap (6) and NPC party cap (12); wild catches/DM give-pokemon always land in party at next open slot; (b) `encounter.enemies[].slotCount` controls enemy slots per NPC at launch (null=match player count), EncounterFormPage shows per-NPC Slots input; (c) `Item.ownerType:'player'|'npc'`, `GET/POST /api/dm/npcs/:id/bag` + `/give-item`, `dm-submit-move` accepts `actionType:'item'` for NPCs, Item tab in NPC Actions panel; (d) `POST /api/battles/:id/dm-auto-submit` runs aiStrategy (random/defensive/optimal) for all unsubmitted NPC slots, "Auto NPCs" button in NPC Actions card
- [x] **4.14** DM EXP/Pokémon panel — `GET /api/dm/players/:username/roster` returns enriched party + PC arrays with HP/EXP progress data; `POST /api/dm/pokemon/:pokemonId/award-exp` runs full level-up + evolution loop (same as `distributeExp`); `POST /api/dm/pokemon/:pokemonId/level-up` is Rare Candy equivalent; `DmPlayersPage` at `/dm/players` — player picker, Party + PC roster cards with HP/EXP bars, per-Pokémon Award EXP input + Level Up button, roster auto-refreshes after each action; "Player Pokémon" nav link added to DM panel
- [ ] **4.15** Multi-target battles & positional adjacency — store PokeAPI `target` field on cached move data (`pokedex_cache.moves[].target`); add `position` (0-based index) to `PlayerSideEntry` and `EnemySideEntry` on the Battle model; `getAdjacentPositions(pos, sideLength)` helper returns ±1 positions clamped to the row; the `target` field drives eligibility (which Pokémon can be selected) not auto-selection — the player always chooses who actually gets hit; spread moves (`all-adjacent`, `all-adjacent-foes`, `all-opponents`, `all-pokemon`) allow clicking 1 up to all eligible Pokémon, then Confirm; single-target moves (`selected-pokemon`, `random-opponent`) allow clicking exactly 1 target — clicking a second deselects the first; Confirm button always present so both cases submit the same way; frontend BattlePage shows each side as a horizontal row with click-to-select/deselect per Pokémon; `target` field on PokeAPI move data fetched in `fetchSpecies` and migration to refresh existing cache entries; key decisions updated: position tracked in-app, adjacency computed from position index (removes self-reported physical-table rule)
- [ ] **4.16** Controllers/routes split — extract the 13 route handler functions into named exports in `controllers/battleController.ts` (`createBattle`, `startBattle`, `sendOut`, `dmSendOut`, `submitMove`, `dmSubmitMove`, `submitTarget`, `advanceRound`, `setWeather`, `deleteBattle`, `getBattleState`, `getDmBattles`, `getActiveBattle`); `routes/battles.ts` becomes a thin manifest of `router.xyz(path, handler)` calls matching the controllers/routes pattern used elsewhere
- [ ] **5.1** EV award engine — post-battle evYield distribution, 252/510 caps
- [ ] **5.2** EV tools — DM EV panel, EV-reducing berries from bag
- [ ] **5.3** Trainer IV activation — +20 stat bonus passed to @smogon/calc
- [ ] **5.4** PvP battles — player vs player format
- [ ] **5.5** TM/HM system — DM teaches TMs/HMs to a player's Pokémon; both work identically (unlimited uses, Gen 8+ style); TM/HM items live in the bag as a new `tm_hm` pocket; teaching a move replaces one of the Pokémon's current 4 moves (player chooses which); only moves the species is compatible with can be taught; compatibility derived from PokeAPI move-learn-method `machine`
- [ ] **5.6** Admin panel — user management, cache refresh, data reset
- [ ] **5.7** Mobile polish — iOS Safari + Android Chrome tested, all touch targets ≥ 44px
- [ ] **5.8** Battle replay — turn log replayable from beginning

---

## Current Milestone

- **Starting:** 4.15 — Multi-target battles & positional adjacency
- **Just finished:** 4.14 — DM EXP/Pokémon panel (roster endpoint, award-exp + level-up endpoints, DmPlayersPage with HP/EXP bars and per-Pokémon controls). Committed and tagged v4.14.
- **Known issues / blockers:** none

---

## Deferred / End-of-Project Fixes

- **Local sprites** — Pokémon images load from `https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/${speciesId}.png`. On machines behind a proxy that requires authentication, incognito/fresh browser sessions get `net::ERR_TUNNEL_CONNECTION_FAILED 407` (regular sessions work because proxy credentials are cached). Fix: download all sprite PNGs from the PokeAPI/sprites GitHub repo into `frontend/public/sprites/pokemon/` and change all image `src` attributes to `/sprites/pokemon/${speciesId}.png`. Affects: DashboardPage, PartyPage, BagPage, PCPage, PokemonDetailPage, DmPage, StarterPage.

---

## How to Use This File

1. Check off milestones as you complete them (`- [x]`)
2. Run the end-of-milestone git routine before closing each session
3. Add to **Conventions Established** as patterns emerge during coding
4. Update **Current Milestone** section before closing each session
