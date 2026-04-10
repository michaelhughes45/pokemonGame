# PokéTTRPG — Claude Context File

> This file is the project memory. Paste it at the start of every new Claude Code session
> or milestone chat. Update it at the end of each milestone before closing the session.

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
  - `escape`: Escape Rope only
  - Everything else (X items, key items, contest items, mail, etc.) — NOT supported
- **No terrain system** — weather only (rain, sun, sandstorm, hail, snow)
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
trainerStatChoice (String), badges ([]), money (Number), createdAt, updatedAt
```
`trainerStats` is a flexible key-value map — new homebrew stats slot in without schema migration.

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
_id (used as poll key), format ('1v1'|'pvp'|'group_vs_npc'|'group_vs_wild'|'6v6'),
status ('waiting'|'active'|'complete'),
playerSide ([{ userId, activePokemonId, fainted:[] }]),
enemySide ([{ npcId|userId, activePokemonId, fainted:[] }]),
turnNumber, turnQueue ([pending submissions]),
weather (null|'rain'|'sun'|'sandstorm'|'hail'|'snow'),
fieldConditions ([{ condition, turnsRemaining }]),
turnLog ([{ turn, events:[] }]),
catchAttempts ([{ playerId, pokemonId, result }]),
expAwarded (Boolean), encounterId, lastUpdatedAt, createdAt, endedAt
```

### `encounters`
```
_id, createdByDm, title, format, enemies ([{ npcId|wildSpeciesId, level, heldItem, moves:[] }]),
wildPokemon ([{ speciesId, levelRange, catchable:true }]),
expMultiplier, notes, isActive
```

### `npcs`
```
_id, createdByDm, name, type ('trainer'|'wild'), party ([ObjectId→pokemon]),
aiStrategy ('random'|'optimal'|'defensive'|'custom'), customAiNotes,
trainerClass, dialogueBefore, dialogueAfter
```

### `items`
```
_id, ownerId, itemId (PokeAPI slug), quantity,
pocket ('healing'|'status_cure'|'pp_recovery'|'stat_booster'|'held_type'|'pokeballs'|'escape')
```

### `pokedex_cache`
```
_id, pokeApiId, name, types ([]), baseStats ({ hp,atk,def,spatk,spdef,speed }),
abilities ([{ name, isHidden, effect, implemented:Boolean }]),
moves ([{ name, type, category, power, accuracy, pp, priority, effect, implemented:Boolean }]),
evolutionChain ([{ speciesId, condition, value }]),
evYield ({ hp,atk,def,spatk,spdef,speed }),
catchRate, expGroup, genderRatio, isLegendary, isMythical, cachedAt
```
Fetched from PokeAPI on first encounter, served from MongoDB cache thereafter.

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

1. DM launches encounter → battle document created in MongoDB
2. Players navigate to `/battle/[id]` — client polls `/api/battle/[id]/state` every 2s
3. Each player POSTs move/item/switch to `/api/battle/[id]/move`
4. Server collects all submissions (or timer expires) → resolves turn server-side
5. `@smogon/calc` runs for each attack, status/weather/ability effects apply
6. Battle document updated in MongoDB with new state + `lastUpdatedAt` bumped
7. Next poll returns updated state — all clients render same turn log
8. Battle ends when one side fully fainted → EXP distributed, evolution checked

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
      middleware/            ← auth middleware (JWT verify)
      models/                ← Mongoose models
      routes/                ← Express routers
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

---

## Completed Milestones

- [x] **1.1** Project setup — repo, React+Vite frontend, Express backend, MongoDB, shadcn/ui, dnd-kit, env vars
- [x] **1.2** Auth — register, login, JWT session, role on user document
- [ ] **1.3** Role guards — middleware, /dm/* and /admin/* protected
- [ ] **1.4** Pokédex seed — fetch-on-demand from PokeAPI, cached to MongoDB
- [ ] **2.1** Trainer profile — /dashboard with username, role, trainer stat specialty
- [ ] **2.2** Starter selection — /starter wizard, Pokémon in party at level 5
- [ ] **2.3** Pokémon detail — /pokemon/[id] with stats, moves, held item, evolution path
- [ ] **2.4** Party management — /party with dnd-kit drag-to-reorder
- [ ] **2.5** PC storage — /pc flat list, swap into party
- [ ] **2.6** Bag & items — /bag with scoped categories, out-of-battle use
- [ ] **3.1** Battle document — DM creates battle, /battle/[id] loads blank battlefield
- [ ] **3.2** Polling loop — client polls, MongoDB change reflects in UI within 2s
- [ ] **3.3** Move submission — player POSTs move, appears in turnQueue
- [ ] **3.4** Turn resolution — @smogon/calc runs, damage applies, HP updates
- [ ] **3.5** Turn log — resolved events display in battle UI
- [ ] **3.6** Status conditions — burn, paralysis, sleep, poison, toxic, confusion
- [ ] **3.7** Weather — rain/sun/sandstorm/hail, @smogon/calc receives weather field
- [ ] **3.8** Items in battle — healing + status cure usable as turn action
- [ ] **3.9** Switching — switch active Pokémon, ability triggers on entry
- [ ] **3.10** Faint & battle end — faint prompt, EXP distributed to full party (Gen 6+ Exp. Share), EV award deferred
- [ ] **3.11** NPC AI — random/optimal move auto-submitted ★ first playable game
- [ ] **4.1** Multi-player battle — two players polling same battle independently
- [ ] **4.2** Group battle format — 3 players vs DM NPC team ★ first real session
- [ ] **4.3** Wild battles & catch — catch formula, Pokémon lands in PC with zeroed EVs
- [ ] **4.4** Evolution engine — level-up check, override rules respected
- [ ] **4.5** DM encounter builder — /dm/encounters, build and launch
- [ ] **4.6** DM NPC builder — /dm/npcs, custom party and AI strategy
- [ ] **4.7** DM EXP panel — /dm/exp, manual EXP award
- [ ] **5.1** EV award engine — post-battle evYield distribution, 252/510 caps
- [ ] **5.2** EV tools — DM EV panel, EV-reducing berries from bag
- [ ] **5.3** Trainer IV activation — +20 stat bonus passed to @smogon/calc
- [ ] **5.4** PvP battles — player vs player format
- [ ] **5.5** Full 6v6 — full party cycling across all formats
- [ ] **5.6** Admin panel — user management, cache refresh, data reset
- [ ] **5.7** Mobile polish — iOS Safari + Android Chrome tested, all touch targets ≥ 44px
- [ ] **5.8** Battle replay — turn log replayable from beginning

---

## Current Milestone

- **Starting:** 1.3 — Role guards (middleware protecting /dm/* and /admin/* routes)
- **Just finished:** 1.2 — User model, bcrypt password hashing, JWT auth, verifyToken middleware, POST /api/auth/register + /login + GET /me all tested and working. Tagged v1.2.
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
