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

**Repo:** github.com/[your-username]/pokettrpg (single monorepo, main branch only)

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
.env.local
.env*.local
node_modules/
.next/
```

### Environment variables
Never commit secrets. Store all of these in Vercel dashboard + local `.env.local`:
```
MONGODB_URI=
NEXTAUTH_SECRET=
NEXTAUTH_URL=
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
enemySide ([{ npcId, activePokemonId, fainted:[] }]),
turnNumber,
turnQueue ([{
  actorId (userId or npcId),
  actorType ('player'|'npc'),
  activePokemonId,
  moveId,
  targets ([pokemonId]) — empty [] during move_submission, filled during targeting phase,
  resolved (Boolean)
}]),
currentTargetIndex (Number) — index into speed-sorted turnQueue for targeting prompts,
weather (null|'rain'|'sun'|'sandstorm'|'hail'|'snow'),
fieldConditions ([{ condition, turnsRemaining }]),
turnLog ([{ turn, events:[] }]),
catchAttempts ([{ playerId, pokemonId, result }]),
playerPokemonLimit (Number | null) — max distinct Pokémon each player may send out; null means no limit (use full party of 6),
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
- [ ] **2.8** Campaign system — DM creates campaign, invites players by username, players accept/decline on dashboard; all DM actions scoped to their campaign's players; one active campaign per user
- [ ] **3.1** Battle document — DM creates battle, /battle/[id] loads blank battlefield
- [ ] **3.2** Polling loop — client polls, MongoDB change reflects in UI within 2s
- [ ] **3.3** Move submission phase — all actors submit move choice (no target yet); round waits until every actor has submitted
- [ ] **3.4** Targeting phase — speed-sorted queue built; each actor prompted in order to select which Pokémon their move hits
- [ ] **3.5** Turn resolution — @smogon/calc runs immediately on target selection per actor; end-of-round status damage ticks after all moves resolve
- [ ] **3.6** Turn log — resolved events display in battle UI
- [ ] **3.7** Status conditions — burn, paralysis, sleep, poison, toxic, confusion
- [ ] **3.8** Weather — rain/sun/sandstorm/hail, @smogon/calc receives weather field
- [ ] **3.9** Items in battle — healing + status cure usable as turn action
- [ ] **3.10** Switching — switch active Pokémon, ability triggers on entry; enforce playerPokemonLimit (track usedPokemonIds, block send-out if limit reached and all used Pokémon still alive)
- [ ] **3.11** Faint & battle end — faint prompt, EXP distributed to full party (Gen 6+ Exp. Share), EV award deferred ★ first playable game
- [ ] **4.1** Wild battles & catch — catch formula, Pokémon lands in PC with zeroed EVs
- [ ] **4.2** Evolution engine — level-up check, override rules respected
- [ ] **4.3** DM encounter builder — /dm/encounters, build and launch, set playerPokemonLimit per encounter ★ first real session
- [ ] **4.4** DM NPC builder — /dm/npcs, custom party (up to 12 Pokémon) and optional AI strategy for auto-submission
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

- **Starting:** 2.8 — Campaign system (DM creates campaign, invite flow, scoped DM actions)
- **Just finished:** 2.7 — Move reminder on Pokémon detail page (PATCH /api/pokemon/:id/moves, bottom Sheet UI, level-filtered learnable moves). Pokémon release (DELETE /api/pokemon/:id, two-step confirmation, last-Pokémon guard applies to all roles). Tagged v2.7.
- **Known issues / blockers:** None

---

## How to Use This File

1. Place this file at the root of your repo as `CLAUDE_CONTEXT.md`
2. Paste the entire file at the start of every new Claude Code session or milestone chat
3. Check off milestones as you complete them (`- [x]`)
4. Run the end-of-milestone git routine before closing each session
5. Fill in **Folder Structure** after milestone 1.1
6. Add to **Conventions Established** as patterns emerge during coding
7. Update **Current Milestone** section before closing each session
