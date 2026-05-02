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
- **NPC parties cap at 12, player parties cap at 6** — allows gym leaders and bosses to field large teams without changing the player experience
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
_id, campaignId (ObjectId), createdByDm, title, type ('pve'|'wild'|'pvp'), enemies ([{ npcId|wildSpeciesId, level, heldItem, moves:[] }]),
wildPokemon ([{ speciesId, levelRange, catchable:true }]),
playerPokemonLimit (Number | null) — carried into battle document on launch; null means no limit,
expMultiplier, notes, isActive
```

### `npcs`
```
_id, campaignId (ObjectId), createdByDm, name, type ('trainer'|'wild'), party ([ObjectId→pokemon], max 12),
aiStrategy ('random'|'optimal'|'defensive'|'custom'), customAiNotes,
trainerClass, dialogueBefore, dialogueAfter
```

### `items`
```
_id, ownerId, itemId (PokeAPI slug), quantity,
pocket ('healing'|'status_cure'|'pp_recovery'|'stat_booster'|'held_type'|'pokeballs'|'escape')
```
Unique index on (ownerId, itemId) — one stack per player per item. Pocket is derived
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
- [ ] **4.2** Evolution engine — level-up check, override rules respected
- [ ] **4.3** DM encounter builder — /dm/encounters, build and launch, set playerPokemonLimit per encounter ★ first real session
- [ ] **4.4** DM NPC builder — /dm/npcs, custom party (up to 12 Pokémon) and optional AI strategy for auto-submission; NPC bag management (give items to NPCs, use in battle via Item tab in NPC Actions — requires `ownerType: 'player'|'npc'` on Item model)
- [ ] **4.5** DM EXP panel — /dm/exp, manual EXP award
- [ ] **5.1** EV award engine — post-battle evYield distribution, 252/510 caps
- [ ] **5.2** EV tools — DM EV panel, EV-reducing berries from bag
- [ ] **5.3** Trainer IV activation — +20 stat bonus passed to @smogon/calc
- [ ] **5.4** PvP battles — player vs player format
- [ ] **5.5** Admin panel — user management, cache refresh, data reset
- [ ] **5.6** Mobile polish — iOS Safari + Android Chrome tested, all touch targets ≥ 44px
- [ ] **5.7** Battle replay — turn log replayable from beginning

---

## Current Milestone

- **Starting:** 4.2 — Evolution engine (level-up check, override rules respected)
- **Just finished:** 4.1 — Wild battles & catch. DM species lookup + randomize, wild Pokémon generation, catch formula, run action, Ball tab + Run button UI. Tag v4.1 when committing.
- **Known issues / blockers:** NPC items deferred to 4.4

---

## How to Use This File

1. Check off milestones as you complete them (`- [x]`)
2. Run the end-of-milestone git routine before closing each session
3. Add to **Conventions Established** as patterns emerge during coding
4. Update **Current Milestone** section before closing each session
