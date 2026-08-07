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
- **EVs are fully active (milestone 5.4)** — `computeStats(base, level, nature, evs, ivs)` takes EVs and IVs as required 4th/5th arguments (standard formula: `floor((2*base + iv + floor(EV/4)) * level/100) + 5`, `+level+10` for HP); `@smogon/calc`'s damage formula also receives real EVs via `toCalcEvs()` in `battleCalc.ts`. No per-Pokémon IVs exist — the only IV source is the Trainer IV system (next bullet).
- **Trainer IV points are earned and freely spent, not a single stat choice (milestone 5.5)** — every player has an IV point pool of `badges.length × 5`, uncapped and always growing; `User.trainerStats` (`Map<String,Number>`) records points already spent per stat. Players split points across any of the 6 stats one point at a time via `POST /api/auth/trainer-stat` (`{ stat, amount }`, validated against the live unspent pool). Once spent, a point is locked in — only a DM reset (`DELETE /api/dm/players/:username/trainer-stat`, clears the whole spread to `{}`) frees it up again. The spread applies to **every Pokémon the trainer owns**, not per-Pokémon — `lib/trainerIv.ts`'s `getIvsForOwner(ownerId, ownerType)` (one `User` lookup, `ZERO_IVS` for non-`'player'` owners) is the single source used everywhere `computeStats()` needs a player-owned Pokémon's IVs, including live battle turn resolution and the `@smogon/calc` damage formula via `toCalcIvs()`.
- **All generations supported** — no gen cap on species, moves, or abilities
- **Esoteric moves flagged `implemented: false`** — fall back to basic damage + DM note in turn log. Cut list: Attract, Helping Hand, Baton Pass, Metronome, Transform, Sketch, Copycat, Me First, Counter, Mirror Coat, Metal Burst, Roar, Whirlwind, Dragon Tail, Trick Room, Magic Room, Wonder Room, Follow Me, Rage Powder, Wide Guard, Quick Guard, Heal Pulse, Aromatic Mist, Wrap, Bind, Fire Spin, Whirlpool, and all other binding/trapping moves
- **Abilities implemented on demand** — all gens cached from PokeAPI with `implemented: Boolean` flag; common ones first, others added as campaign needs them
- **Scoped item system** — only these categories supported:
  - `healing`: Potion, Super Potion, Hyper Potion, Max Potion, Full Restore, Revive, Max Revive
  - `status_cure`: Antidote, Parlyz Heal, Burn Heal, Ice Heal, Awakening, Full Heal
  - `pp_recovery`: Ether, Max Ether, Elixir, Max Elixir
  - `stat_booster`: HP Up, Protein, Iron, Calcium, Zinc, Carbos (EV vitamins, +10 EV each, clamped to the 252/510 caps); PP Up, PP Max (raise a move's max PP — see PP Up convention below)
  - `held_type`: Charcoal, Mystic Water, Magnet, Miracle Seed, Never-Melt Ice, Spell Tag, TwistedSpoon, Black Belt, Poison Barb, Soft Sand, Hard Stone, Silver Powder, Sharp Beak, Dragon Fang, Black Glasses, Silk Scarf, Metal Coat
  - `pokeballs`: all variants
  - `escape`: Escape Rope only (consumed out of battle, no mechanical effect until overworld added)
  - `berry`: all berries share one bag tab regardless of effect — Oran, Sitrus (healing), Cheri, Chesto, Pecha, Rawst, Aspear, Lum (status cure), Pomeg, Kelpsy, Qualot, Hondew, Grepa, Tamato (EV-reducing, -10 EV each, one per stat)
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
- **Targeting enforces move shape, not adjacency** — the `target` field cached from PokeAPI on each move drives how many targets can be selected: `auto` moves (all-opponents, all-adjacent-foes, all-adjacent, all-pokemon, etc.) hit every active enemy automatically with no picker; `single` moves allow exactly one target (clicking a second replaces the first). Adjacency is still self-reported from the physical table — the app does not track position. `getMoveTargetCategory(target)` in `lib/moveData.ts` maps PokeAPI target strings to `'single' | 'auto'`; `currentMoveTargetCategory` is returned by the state endpoint each poll.
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
- **PvP battles (milestone 5.6)** — DM creates a pvp battle by picking two rosters of campaign players (`playerIds` for Team A, `enemyPlayerIds` for Team B — a player can only be on one side); `enemySide` entries gain an optional `userId`/`usedPokemonIds` so a pvp opponent's entries are structurally identical to `playerSide`'s. `findOwnSideEntry(battle, userId)` in `battleController.ts` is the single lookup that resolves "which side, if any, does this user act on" (checks `playerSide` first, then `enemySide`) — used by send-out, move submission, and switch resolution instead of assuming the acting player is always on `playerSide`. `isTrainerSideEliminated(entries, pokemonLimit)` is the shared "does this trainer roster have any usable Pokémon left" check, reused for `enemySide` in pvp instead of the NPC/wild-specific elimination logic. `playerPokemonLimit` is reused symmetrically for both sides in pvp (no separate second limit field). EXP/EVs are awarded to **both** sides in pvp (each side gains from the other's fainted Pokémon, via the shared `awardExpToSide` helper) — no money changes hands in pvp under any circumstance. `Battle.winningSide` records which side won; since the turn log is shared by both viewers it stays neutral ("One side has no more usable Pokémon..."), and the frontend uses `winningSide` + which side the viewer is on to show a personalized win/loss banner. The DM still creates/starts/advances every pvp battle and sets weather (same referee role as pve/wild) — they just never submit moves for either side, since both are real players now. The DM's NPC-actions panel and BattlePage's "Player Side"/"Enemy Side" labels/rendering are conditionally suppressed or relabeled for `type === 'pvp'` throughout `BattlePage.tsx`.
- **NPC (pve) battle money rewards (added post-5.6)** — DM sets an optional `moneyReward` (Pokédollars) when creating a pve battle directly or on a pve `Encounter` (carried to `Battle.moneyReward` at launch); only valid for `type === 'pve'` (rejected for wild/pvp). On victory, `awardBattleMoney` in `battleController.ts` pays the **full** `moneyReward` amount to **every** `playerSide` trainer via `User.money` `$inc` — not split, not scaled by participation (unlike EXP's active/benched distinction). Guarded by `Battle.moneyAwarded`, mirroring `expAwarded`'s double-award protection.
- **TM/HM system (milestone 5.7)** — TMs and HMs are identical items (Gen 8+ style: unlimited uses, never consumed on teach) sharing one `tm_hm` bag pocket. Item identity is synthesized as `tm-<moveId>` (e.g. `tm-flamethrower`) rather than PokeAPI's real numbered TM/HM items, since real TM numbers are version-group-specific and would conflict with "all generations supported." Two independent validity checks exist for two different questions: `lib/tmHmData.ts`'s static `TM_HM_MOVES` catalog (`isTmHmMove()`) answers "does this move exist as a real TM/HM at all" — generated once by `backend/src/scripts/buildTmHmCatalog.ts`, a build script that sweeps every PokeAPI move and checks its `machines` array, same shape of problem as the badge catalog; checked whenever a DM gives the item. `PokedexCache.machineMoves` (per-species, added in `fetchSpecies()`) answers "can this specific species learn it via TM/HM" — checked whenever a player teaches it. `fetchSpecies()`'s move-detail fetch was expanded from level-up-only to the union of level-up + machine moves, because battle resolution looks up a Pokémon's move data by name in the cached `moves[]` array — a TM-taught move with no cached detail would silently fail to resolve in battle (confirmed live: Toxic taught to Bulbasaur, a TM-only move for that species, resolves correctly in a real battle turn). `PATCH /api/pokemon/:id/teach-tm` (player self-service, mirrors `replaceMoveSlot`/Move Reminder) is the teach endpoint — validates against the bag (checking the Pokémon's *owner's* bag via `pokemon.ownerId`, not necessarily the caller's, since DM/admin can still act on any Pokémon like other mixed-use routes) and `machineMoves`, then swaps a slot; critically, it never decrements item quantity. DM give-item gained a general (not TM-specific) bulk mode: `POST /api/dm/campaign/items/give` gives one item to every player in the DM's active campaign at once, each player still getting their own independent `Item` doc/quantity via the same upsert `givePlayerItem` already used, just looped.
- **Admin panel (milestone 5.8)** — `role: 'admin'` gets its own dedicated `/admin` route (stricter `RequireAdmin` guard, not the shared DM-or-admin `RequireDm`), covering three capabilities: (1) user management — `GET /api/admin/users` (role, email, resolved campaign name), `PATCH .../:id/role`, `DELETE .../:id`; (2) Pokédex cache management — `GET /api/admin/pokedex` search + `POST .../:id/refresh` force re-fetch from PokeAPI; (3) bulk cleanup — `POST /api/admin/users/bulk-delete`, built specifically to sweep the disposable test accounts noted in past milestones' live-verification passes. Guardrails: role changes block self-demotion and demoting the last remaining admin; user deletion cascades the target's own Pokémon/Items and campaign membership, and — if they're a DM — cascades their whole campaign tree (NPCs, NPC-owned Pokémon/Items, Encounters, Battles) *unless* that campaign still has other real players, in which case deletion is blocked outright rather than silently destroying someone else's campaign as a side effect of deleting an unrelated account; bulk-delete reuses the identical cascade via a shared `cascadeDeleteUser()` helper, never touches admin-role accounts regardless of pattern match, and requires a ≥3-character pattern so a too-broad match can't sweep the whole user table.
- **Registration never accepts a client-supplied role (security fix, found during 5.8)** — `POST /api/auth/register` previously trusted a `role` field straight off the request body, letting anyone self-register as `admin` with zero authentication. Never exercised through the actual frontend (`RegisterPage.tsx` never sent a `role` field), but reachable directly via the API. Fixed: registration always creates `role: 'player'`; elevating to `dm`/`admin` only ever happens via an existing admin's `PATCH /api/admin/users/:id/role`.
- **No animations** — shadcn/ui CSS transitions only, no Framer Motion
- **PC storage is a flat list** — no box grid system
- **Pokédex shows only encountered species** — fetch-on-demand from PokeAPI, cached to MongoDB on first view
- **Dark mode (milestone 5.9)** — `ThemeProvider`/`ThemeContext`/`useTheme` (`frontend/src/context/`, `frontend/src/hooks/useTheme.ts`) mirror the existing `AuthProvider` pattern exactly: theme is `'light' | 'dark'` (no `'system'` option, but defaults to `prefers-color-scheme` on first visit), persisted to `localStorage['theme']`, applied by toggling a `.dark` class on `<html>`. An inline blocking `<script>` in `frontend/index.html`'s `<head>` (before React loads) applies the class synchronously from `localStorage` to prevent a flash-of-wrong-theme on load. `ThemeToggle` (`frontend/src/components/ThemeToggle.tsx`) is a single floating button rendered once at the `App.tsx` root (inside `ThemeProvider`, outside `AuthProvider` so it's visible even on login/register) — deliberately **not** part of any page header, since no shared nav/layout component exists yet (each page still renders its own inline nav links; the "fixed bottom tab bar" Mobile-First Rule is aspirational, not yet built). Positioned `fixed bottom-4 right-4` (not top-right) because top-right collides with per-page header buttons like Dashboard's "Log out". shadcn had already scaffolded full light/dark CSS variable pairs in `index.css` (unused until this milestone) — dark mode was "activate the toggle," not "invent the palette." A color audit swept every page for hardcoded Tailwind colors bypassing those semantic tokens (raw `bg-green-50 text-green-900` etc. that would render identically washed-out in dark mode) and added explicit `dark:` variants where the pale/dark shade pairing was genuinely broken (badges, banners, warning toggles, feedback text) — solid mid-tone colors with fixed white text (HP/EXP/PP bars, Pokémon-type badges, status-condition badges) were left alone since they already have self-contained contrast regardless of page theme. The duplicated `TYPE_BG` Pokémon-type-color map (copy-pasted verbatim into 5 files) was consolidated into `frontend/src/lib/typeColors.ts` while touching those files anyway.
- **Move effectiveness messages (bug fix, found during 5.9)** — `resolveMove` in `battleController.ts` previously tried to detect "super effective"/"not very effective" by string-matching `@smogon/calc`'s `result.desc()` output; that library's `desc()` text never actually contains those phrases anywhere (confirmed by reading `@smogon/calc`'s source), so the check had silently never fired, in any battle, ever. Fixed with a new `getTypeEffectiveness(moveType, defenderTypes)` in `lib/battleCalc.ts` that computes the real multiplier directly from `@smogon/calc`'s own type chart (`GEN9.types.get(moveType).effectiveness`), correctly handling dual-types by multiplying both. The rare fallback damage formula (used only when `@smogon/calc` throws) previously ignored type effectiveness entirely and now scales by the same multiplier, so the log message and actual damage dealt stay consistent even on that path.
- **Town/Field mode (milestone 5.10)** — `Campaign.fieldModeEnabled` (default `false` = Town mode) is a DM-only campaign-wide toggle, same shape and route pattern as `levelCapEnabled`/`PATCH /api/campaigns/level-cap` (`PATCH /api/campaigns/field-mode`, `{ enabled: boolean }`), and is returned alongside it on every `GET /api/campaigns/mine` call so no new fetch was needed anywhere. Field mode blocks players (never DMs/admins, who have no player character) from `/pc` and `/town` only — nothing else is gated. Enforcement is entirely client-side: `RequireTownMode` in `App.tsx` (same shape as `RequireDm`/`RequireAdmin`) checks the campaign's current mode before rendering `PCPage`/`TownPage` and redirects to `/dashboard` with `state.blockedMessage` set when blocked; `DashboardPage` reads that state and shows an amber banner. Players with no active campaign are never gated (nothing to check against).

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
_id, username, email, passwordHash, role, trainerStats (Map<String,Number>),
badges ([]), money (Number), currentCampaignId (ObjectId | null), createdAt, updatedAt
```
`trainerStats` records spent Trainer IV points per stat (e.g. `{speed:35}`, milestone 5.5) —
total pool is derived from `badges.length × 5`, never stored. Flexible key-value map — new
homebrew stats would slot in without schema migration.

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
enemySide ([{ npcId (absent for wild/pvp), userId (pvp only — opposing trainer), usedPokemonIds:[] (pvp only), activePokemonId, fainted:[] }]),
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
playerPokemonLimit (Number | null) — max distinct Pokémon each player may send out; null means no limit (use full party of 6); in pvp this limit is reused symmetrically for enemySide's trainers too,
wildCatchable (Boolean) — false lets DM use wild Pokémon as a pure fight,
moneyReward (Number) — pve only; Pokédollars paid to every playerSide trainer (not split) on victory; 0 for wild/pvp,
expAwarded (Boolean), moneyAwarded (Boolean),
winningSide ('playerSide'|'enemySide'|null) — set on completion; for pvp the frontend uses this + which side the viewer is on to show a personalized win/loss result, since the turn log is shared and stays neutral,
encounterId, lastUpdatedAt, createdAt, endedAt
```

### `encounters`
```
_id, campaignId (ObjectId), createdByDm (ObjectId→user), title, type ('pve'|'wild'),
enemies ([{ npcId (ObjectId→npc), slotCount (Number|null) }]) — PvE only; slotCount sets how many enemySide slots this NPC gets (null = match player count at launch),
wildPokemon ([{ speciesId, level, catchable (Boolean) }]) — Wild only; each entry generates one live Pokémon doc on launch,
playerPokemonLimit (Number | null), npcPokemonLimit (Number | null), moneyReward (Number, pve only — carried to Battle.moneyReward at launch),
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

## Badge Image Source

PokeAPI has no gym badge data or imagery (confirmed — its resource categories are berries,
contests, encounters, evolution, games, items, locations, machines, moves, pokémon, and
utility only). For the Badge System milestone (5.3), badge names and artwork come from
**Bulbapedia**: https://bulbapedia.bulbagarden.net/wiki/Badge — image URLs must be verified
individually per badge (Bulbapedia archive URLs use unpredictable hash-prefixed paths), never
guessed or bulk-assumed.

---

## Damage Calculation

**@smogon/calc** — installed via `npm install @smogon/calc`.
- Runs server-side only during turn resolution
- No external network calls — pure calculation library
- Receives real EVs via `toCalcEvs()` and real Trainer IVs via `toCalcIvs()` (both in `battleCalc.ts`)
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
        itemData.ts          ← getPocket(itemId) lookup table; BATTLE_ITEM_EFFECTS, BALL_MODIFIERS, statusCatchModifier
        pokeapi.ts           ← fetchSpecies (PokeAPI fetch + transform)
        moveData.ts          ← all move tables + types + getHitCount + getMoveTargetCategory + derived sets
        abilityData.ts       ← STATUS_IMMUNITY_ABILITIES, ILATE_MAP, PINCH_ABILITIES, WEATHER_SPEED_DOUBLERS
        weatherData.ts       ← WEATHER_MOVES, ENTRY_ABILITY_WEATHER, ENTRY_WEATHER_MESSAGES
        battleCalc.ts        ← GEN9, CachedAbility, slugToDisplayName, pokeDisplayName, toCalcWeather, toCalcStatus, resolveAbilitySlug, applyStatStageEffects, cap, ZERO_STATS, appendToLog
        evData.ts            ← EV_STAT_CAP, EV_TOTAL_CAP, EV_STAT_DISPLAY_NAMES, applyEvGain — Phase 5 stat-progression home (EV award engine now, EV-reducing berries + Trainer IV bonus land here too)
        levelCap.ts          ← getEffectiveLevelCap, getPlayerEffectiveLevelCap, applyLevelUpLoop, unlockPendingLevelUpsForPlayer — level-cap math + the shared capped level-up/evolution loop used by every EXP-granting path
        tmHmData.ts          ← TM_HM_MOVES (static catalog), isTmHmMove — generated by scripts/buildTmHmCatalog.ts, see milestone 5.7 Key Decision
      middleware/            ← auth middleware (JWT verify, requireDm)
      models/                ← Mongoose models (User, Pokemon, Item, PokedexCache, Battle, etc.)
      controllers/
        battleController.ts  ← all battle route handlers + helpers (~1,900 lines); routes/battles.ts imports from here
      routes/                ← Express routers (auth, pokemon, items, starter, dm, admin, pokedex, battles)
      scripts/               ← one-off dev scripts, not run by the server (e.g. buildTmHmCatalog.ts) — run via tsc + node, not ts-node, see Conventions Established
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
- `target` field (`String`, default `''`) stored on `PokedexCache.moves[]`; fetched from `data.target.name` in `fetchSpecies`; stale entries auto-refresh on the next `fetchSpecies` call
- `getMoveTargetCategory(target: string)` in `lib/moveData.ts` returns `'auto'` for spread/field target values or `'single'` for everything else; falls back to `'single'` when target is empty or unrecognised
- State endpoint computes `currentMoveTargetCategory: 'single' | 'auto' | null` for the current targeting actor's move (single `$elemMatch` PokedexCache query); `null` when not in targeting phase or actor has no moveId
- Auto-target moves in BattlePage use `handleAutoTargetMove(targetIds)` (separate from `handleSubmitTarget`) to avoid the React state race condition of calling `setSelectedTargets` + `handleSubmitTarget` in sequence
- `applyEvGain(current, gain)` in `lib/evData.ts` is the single source of truth for EV math — clamps per-stat to 252 and total to 510, returns both the new spread and the display names of stats that actually increased; `distributeExp` computes `totalEvYield` once (summed across all fainted enemies) and applies it identically to active and benched party Pokémon in the same loop that awards EXP, persisting `evs` in the same `updateOne` as `exp`/`level`/`currentHp`
- EV turn-log line (`"<Name> gained EVs in <Stat, Stat>!"`) is pushed only when `gainedStats.length > 0` — a Pokémon already at the cap gets its EXP line with no EV line following
- Every level-raising path shares one loop: `applyLevelUpLoop` in `lib/levelCap.ts` is the extracted level-up/evolution while-loop bounded by a `cap` param; `distributeExp`, DM `awardExp`, and `unlockPendingLevelUpsForPlayer` all call it instead of duplicating the loop inline — a Pokémon's `exp` field always banks the full amount regardless of cap, only `level`/`currentHp`/`speciesId` stop advancing
- Single-level-increment paths (DM `levelUp`, Rare Candy in `itemController.ts`) don't go through `applyLevelUpLoop` (no exp math involved) — they just guard with `getPlayerEffectiveLevelCap` before incrementing and return a level-cap-specific error message distinct from the old "already at level 100" one
- `getPlayerEffectiveLevelCap(userId)` is for single-player call sites with no campaign already in hand; batched call sites (`distributeExp` across a whole battle's players, the campaign-wide unlock pass) compute `getEffectiveLevelCap(badgeCount, levelCapEnabled)` directly per player to avoid N redundant Campaign lookups
- Toggling `Campaign.levelCapEnabled` (`PATCH /api/campaigns/level-cap`) immediately calls `unlockPendingLevelUpsForPlayer` for every player in the campaign against their new cap — this is what converts already-banked exp into levels the instant the cap rises, without waiting for the next battle or DM action to touch that Pokémon
- Badge catalog lives in `backend/src/lib/badgeData.ts` (`BADGE_CATALOG`, 66 official gym badges across Kanto/Johto/Hoenn/Sinnoh/Unova-BW/Kalos/Galar/Paldea — Alola excluded, no gym badges; Galar includes all 4 Sword/Shield version-exclusive badges); `badgeId` is globally unique and region-prefixed (e.g. `galar-fairy-badge`, `paldea-fairy-badge`) since several badge names repeat across regions; every image was individually verified against Bulbapedia (never guessed) and downloaded locally to `frontend/public/badges/{region}/{badge-id}.png` rather than hotlinked, avoiding the same proxy/hotlink problem noted for Pokémon sprites in Deferred Fixes
- `User.badges` restructured from an unused `string[]` to `{ badgeId, name, imageUrl, awardedAt }[]` — denormalized at award time so a player's own badge list never needs a catalog lookup to render (dashboard, DM roster view)
- `Campaign.customBadges` embedded array (`{ badgeId, name, imageUrl, createdAt }`) holds DM-defined homebrew badges for campaigns that want gyms beyond the hardcoded catalog; `badgeId` is server-generated (`custom-<ObjectId>`), never DM-chosen, so it can't collide with a catalog ID or another custom one; deleting a custom badge definition does not retroactively strip it from players already awarded it (same denormalized-copy behavior as catalog badges)
- Badge routes: `GET /api/dm/badges` (catalog), `GET/POST /api/dm/badges/custom`, `DELETE /api/dm/badges/custom/:badgeId`, `POST /api/dm/players/:username/badges` + `DELETE .../badges/:badgeId`; `awardBadge` checks the catalog and the DM's `customBadges` before rejecting a `badgeId`, so award/revoke work identically regardless of badge origin; awarding calls `getPlayerEffectiveLevelCap` + `unlockPendingLevelUpsForPlayer` immediately after persisting (a badge can only raise a player's cap, never lower it — revoke needs no equivalent call since the cap is always computed fresh at every EXP-awarding call site, never cached)
- `ItemPocket` gained `'berry'` — every berry (healing, status-cure, and EV-reducing alike) lives in one bag tab regardless of effect; `BattlePage.tsx`'s in-battle item filters include `berry` but exclude the 6 EV-reducing ones via an `EV_BERRIES` set (they have no `BATTLE_ITEM_EFFECTS` entry and would silently no-op in battle)
- `evData.ts` (`EV_STAT_CAP`=252, `EV_TOTAL_CAP`=510, `EV_STAT_DISPLAY_NAMES`, `applyEvGain`) is the single source of truth for EV clamping — reused by the battle EV-award engine (5.1), vitamins/berries in `itemController.ts` (`ev_boost`/`ev_reduce` effect kinds), and the DM EV panel's validation
- Vitamins (`ev_boost`) add +10 EV via `applyEvGain`; EV-reducing berries (`ev_reduce`: Pomeg/Kelpsy/Qualot/Hondew/Grepa/Tamato, one per stat) subtract 10 floored at 0 — both out-of-battle bag items only
- PP Up/PP Max implemented as the real game mechanic, not an EV item: `ppUps: number` (0–3, default 0) on each move subdocument; `pp_up` effect kind reads the move's *base* PP from `PokedexCache`, boost per PP Up = `floor(basePP × 0.2)`, PP Up adds one stage (capped at 3), PP Max jumps straight to 3; both max PP and current PP rise by the delta; a newly learned move (Move Reminder) resets `ppUps` to 0 — the boost is tied to the move, not the slot
- `computeStats(base, level, nature, evs)` takes EVs as a **required** 4th argument (no optional/default) so every call site had to be updated deliberately rather than silently keep computing on zero EVs; `ZERO_EVS` exported from `statCalc.ts` for the handful of brand-new-Pokémon-creation sites (starter selection, wild battle/encounter generation) where EVs are genuinely zero at that instant
- `toCalcEvs(evs)` in `battleCalc.ts` maps our stored EV shape (`spatk`/`spdef`/`speed`) to `@smogon/calc`'s stat-key shape (`spa`/`spd`/`spe`); used in `resolveMove` (real battle damage) and `estimateDamage` (DM "optimal" NPC AI) so EVs affect actual damage dealt/taken, not just max HP
- DM EV panel: `PATCH /api/dm/pokemon/:pokemonId/evs` (guarded by `assertDmOwnsPokemon`) sets a Pokémon's full EV spread directly, bypassing the +10/-10 increments players get from vitamins/berries; validates each stat 0–252 and total ≤510; `ActionControls` in `DmPlayersPage.tsx` has an "Edit EVs" toggle beneath Award EXP/Level Up
- NPC party-count staleness fix: `NpcCard` and `NpcPartyManagerCard` in `DmPage.tsx` each cache their own copy of the NPC list; `NpcPartyManagerCard.loadParty()` reconciles the cached `partyCount` against the just-fetched real party (which queries live `Pokemon` docs, not the `npc.party` array) since a release done via the separate `/pokemon/:id` route wouldn't otherwise be reflected until re-viewed; both cards also got manual "Refresh" buttons
- `computeStats(base, level, nature, evs, ivs)` takes IVs as a **required** 5th argument (same deliberate-break convention as EVs); `ZERO_IVS` exported from `statCalc.ts` for every NPC/wild call site and any not-yet-relevant one
- `lib/trainerIv.ts` is the single home for Trainer IV math: `getTrainerIvPool(badgeCount)` = `badgeCount × 5` (uncapped); `ivsFromSpread(raw)` normalizes a stored spread (Mongoose Map or plain object) into a full 6-key `BaseStats` object, defaulting missing stats to 0 — this is the only shape sent to the client or passed to `computeStats()`, matching how EVs are always a full object rather than a sparse map; `getUnspentTrainerIv(badgeCount, raw)` = pool minus spent; `getIvsForOwner(ownerId, ownerType)` does one `User` lookup and returns `ZERO_IVS` immediately for any `ownerType !== 'player'` (NPC/wild never carry a bonus)
- Trainer IV points are earned passively (`badges.length × 5`, uncapped) but spent explicitly and irreversibly per stat — `POST /api/auth/trainer-stat` (`{ stat, amount }`) validates `amount` against the live unspent pool and `$inc`s `trainerStats.<stat>`; `DELETE /api/dm/players/:username/trainer-stat` resets the whole spread to `{}` (DM-only, campaign-scoped via `assertCampaignPlayer`) — there is no player self-service respec
- Call sites that process many Pokémon per request (`applyEndOfRound`, `checkAndAdvance`'s turn-order speed sort, `getBattleState`'s `buildInfo`, DM "optimal" AI's `estimateDamage` targets) batch-fetch all relevant owners' `trainerStats` **once** via a single `User.find({_id:{$in:...}})`, then build a local `ivsMap`/`pokeIvs(poke)` closure — never one `User` lookup per Pokémon in a loop
- `toCalcIvs(ivs)` in `battleCalc.ts` mirrors `toCalcEvs()` — maps our stored IV shape to `@smogon/calc`'s stat-key shape; used in `resolveMove` (real battle damage) and `estimateDamage` (DM "optimal" NPC AI) so Trainer IVs affect actual damage dealt/taken, not just max HP/speed bookkeeping; `ZERO_STATS` (the old always-zero fallback) was removed from `battleCalc.ts` once both call sites switched to real values
- `findOwnSideEntry(battle, userId)` in `battleController.ts` — the single lookup for "which side, if any, does this user act on" (checks `playerSide` first, then `enemySide` by `userId`); introduced for pvp and used by `sendOut`, `submitMove`, and `resolveSwitch` instead of hardcoding `playerSide`. A related but distinct bug fixed alongside it: `actorType: 'player'` is not the same thing as "on `playerSide`" — a pvp opponent's turnQueue entries are `actorType: 'player'` but live on `enemySide`, so `submitTarget`'s target-validity check and Fake Out's "did I just switch in" check both had to stop branching on `actorType` and instead resolve the actor's actual side
- `isTrainerSideEliminated(entries, pokemonLimit)` in `battleController.ts` — "does this roster of real trainers have any usable Pokémon left," extracted from the existing `playerSide`-only check in `checkBattleEnd` so pvp can apply the identical rule to `enemySide` (a trainer roster there too, not NPCs/wild)
- `awardExpToSide(battle, gainingEntries, faintedOpponentIds)` in `battleController.ts` — the per-trainer EXP/EV award loop (used by `distributeExp`) extracted so pvp can call it twice (each side gains from the other's fainted Pokémon) instead of once (pve/wild: `playerSide` only)
- `Battle.winningSide` (`'playerSide'|'enemySide'|null`) is set whenever `checkBattleEnd` completes a battle; for pve/wild it always mirrors "did the players win." The turn log itself never says "you win" (it's shared by both viewers in pvp), so the frontend combines `winningSide` with which side the logged-in user is on to render a personalized result
- `BattlePage.tsx`'s `myEntry`/`mySide` resolve from **either** `playerSide` or `enemySide` (mirroring `findOwnSideEntry`) — before this fix a pvp participant seated on `enemySide` had no `myEntry` at all and saw a completely non-functional page, since nearly every player-facing action block was already gated on `myEntry`/`!isDm` rather than hardcoded to `playerSide`
- `moneyReward`/`moneyAwarded` on `Battle`, `moneyReward` on `Encounter` — pve-only Pokédollar reward, validated as non-negative and rejected outright for non-pve types at every write site (`createBattle`, `createEncounter`, `updateEncounter`); `awardBattleMoney` pays the full amount to every `playerSide` trainer via `User.money` `$inc` (not split, not scaled by participation) alongside `distributeExp` in `checkBattleEnd`'s pve win branch
- `getPocket(itemId)` in `lib/itemData.ts` resolves `tm_hm` by prefix check (`itemId.startsWith('tm-')`) rather than an exhaustive `ITEM_POCKET_MAP` entry like every other item — there are hundreds of possible TM/HM moves, too many to hardcode individually; `moveIdFromTmItem(itemId)` strips the prefix back off. `resolveItemPocket` in `dmController.ts` (shared by both give-item endpoints) additionally validates the extracted move against `isTmHmMove()` when the pocket is `tm_hm`
- One-off dev scripts belong in `backend/src/scripts/` (inside `src/` so `tsconfig.json`'s `include: ["src/**/*"]` picks them up) — but run them via `npx tsc && node dist/scripts/<name>.js`, not `ts-node` directly. `ts-node@10.9.2` fails to resolve Node's ambient global types (`console`/`process`/`fs`/`__dirname`) for a standalone script with no imports into the app's own module graph — a version-mismatch quirk with `typescript@6.0.2` in this project. The real app entry point (`ts-node src/index.ts`) boots fine since its import graph (mongoose, express, etc.) pulls in the needed type declarations; plain `tsc` also resolves everything correctly project-wide. Confirmed while building `buildTmHmCatalog.ts` (milestone 5.7)
- `cascadeDeleteUser(id, requesterId)` in `adminController.ts` is the single source of truth for deleting a user and everything they own — returns `{ ok: true } | { ok: false, reason }` instead of writing the HTTP response directly, so both the single-delete route and the bulk-delete sweep share identical guardrails/cascade logic without duplicating it
- Mongoose array-field queries (`{ playerIds: id }`, `$pull` against an `ObjectId[]` field) need an actual `ObjectId`, not a raw route-param string — cast once with `new mongoose.Types.ObjectId(id as string)` and reuse it; a bare string route param satisfies looser overloads (`findById`) but not these
- PokedexCache refresh is safe to fully overwrite on demand — `implemented` flags on cached moves/abilities always come back `false` from `fetchSpecies()`, so there's no hand-curated per-doc state a force-refresh could clobber; "implemented" is actually decided by the static move/ability tables in `moveData.ts`/`abilityData.ts` at battle time, not this field
- `frontend/vite.config.ts` sets `server: { host: true }` so the dev server binds to all network interfaces, not just `localhost` — lets you test the app on a phone over local Wi-Fi by browsing to the dev machine's LAN IP. For this to actually work end-to-end, `frontend/.env`'s `VITE_API_URL` and `backend/.env`'s `FRONTEND_URL` (CORS origin) both need to point at that LAN IP instead of `localhost` (gitignored, local-only change — never committed), and Windows Firewall may need an inbound allow rule for ports 4000/5173 on whatever network profile is active (`Get-NetConnectionProfile` to check). None of this affects deployment — Vercel/Railway use their own dashboard-configured env vars, completely separate from local `.env` files.

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
- [x] **4.15** Move targeting enforcement — `target` field added to `PokedexCache.moves[]` schema and fetched from PokeAPI in `fetchSpecies`; `getMoveTargetCategory(target)` helper in `lib/moveData.ts` categorises moves as `'auto'` (spread/field: all-opponents, all-adjacent-foes, all-adjacent, all-pokemon, all-other-pokemon, entire-field) or `'single'` (everything else); state endpoint looks up the current actor's move target from cache and returns `currentMoveTargetCategory: 'single' | 'auto' | null`; frontend: auto moves show "Use [Move] — hits all (N)" button that submits all active opposing Pokémon IDs via `handleAutoTargetMove`; single moves enforce one selection (click replaces, not toggles); adjacency remains self-reported from physical table — no position tracking added
- [x] **4.16** `battles.ts` cleanup — `submit-target` `if (!hitSelf)` block split into three named async helpers (`resolveWeatherMove`, `resolveSelfTargetMove`, `resolveDamagingMove`) with `ActiveEntry` type alias; 5 duplicate 1/16-heal blocks in `applyEndOfRound` consolidated into `applyFractionHeal` helper (Rain Dish, Ice Body, Dry Skin rain, Ingrain, Aqua Ring); `cap` / `ZERO_STATS` exported from `lib/battleCalc.ts` replacing two inline re-declarations
- [x] **4.17** Controllers/routes split — all route handlers and every battle helper extracted from `routes/battles.ts` into `controllers/battleController.ts`; `routes/battles.ts` reduced from ~3,800 lines to a 68-line annotated route manifest (`router.verb(path, middleware?, handler)` per line); exported handlers: `createBattle`, `startBattle`, `sendOut`, `dmSendOut`, `submitMove`, `dmSubmitMove`, `submitTarget`, `advanceRound`, `setWeather`, `deleteBattle`, `getBattleState`, `getDmBattles`, `getActiveBattle`, `dmAutoSubmit`; private helpers stay in the same file (not exported); `checkAndAdvance` and `applyEntryAbilities` exported because DM routes call them directly
- [x] **5.1** EV award engine — `applyEvGain(current, gain)` in new `lib/evData.ts` clamps a stat spread to the 252-per-stat / 510-total EV caps; `distributeExp` in `battleController.ts` sums `evYield` across all fainted enemies once per battle-end call and applies it to every party Pokémon that gained EXP (active and benched alike get the FULL yield — EVs are not halved for benched Pokémon like EXP is); logs a single combined turn-log line per Pokémon (`"<Name> gained EVs in <Stat, Stat>!"`) immediately after that Pokémon's EXP line, omitted entirely when no stat actually increased (already capped); verified end-to-end against a real battle on the live Atlas DB
- [x] **5.2** Level Cap System — `Campaign.levelCapEnabled` (default **true** for new campaigns), DM-only `PATCH /api/campaigns/level-cap` toggle; `lib/levelCap.ts` is the single home for cap math and the shared capped level-up loop: `getEffectiveLevelCap(badgeCount, levelCapEnabled)` = 6 + 3×badges (or 100/uncapped when disabled), `getPlayerEffectiveLevelCap(userId)` for single-player call sites with no campaign in hand (returns 100 if the player has no current campaign), `applyLevelUpLoop(...)` is the old inline level-up/evolution while-loop extracted and bounded by a `cap` param instead of the hard 100 ceiling (pure — callers persist the result), `unlockPendingLevelUpsForPlayer(ownerId, cap)` replays a player's whole roster against a new cap and persists any newly-unlocked levels/evolutions; wired into every level-raising path for player Pokémon only — battle EXP (`distributeExp`), DM award-exp, DM level-up, Rare Candy (`itemController.ts`) — each now reports a `"<Name> has reached the level cap and cannot grow further!"` log line when banked EXP is blocked, and DM level-up/Rare Candy return a distinct "already at its level cap (Lv. X)" error instead of the old level-100 message; toggling the cap off (or re-enabling at a lower value) runs `unlockPendingLevelUpsForPlayer` across every campaign player and returns `unlockedCount`, converting banked EXP into levels immediately — existing levels are never retroactively lowered when the cap tightens (confirmed live: level 38 stayed at 38 after re-enabling a cap of 6); NPCs/wild are never bound by any of this since the helpers only ever touch `ownerType: 'player'` Pokémon; DM panel has an on/off toggle button on the Campaign card, Pokémon detail page shows an "At level cap" badge under the EXP bar when `level >= levelCap`; verified end-to-end via live HTTP requests against the real Atlas DB with disposable test accounts (registered, exercised, then deleted)
- [x] **5.3** Badge System — hardcoded catalog of 66 official gym badges across 8 regions (`lib/badgeData.ts`), each with a real image individually sourced/verified from Bulbapedia and downloaded locally to `frontend/public/badges/` (never hotlinked); `User.badges` restructured to `{ badgeId, name, imageUrl, awardedAt }[]`; DM-only award/revoke endpoints scoped to campaign membership, plus `Campaign.customBadges` for DM-defined homebrew badges beyond the catalog; awarding immediately re-runs the 5.2 level-cap recalculation for that player (revoke needs no equivalent — the cap is always computed fresh, never cached); DM panel (`/dm/players`) gained a campaign-wide Custom Badges card and a per-player Badges card (award dropdown grouped by region + custom, held badges shown as image tiles with revoke); player dashboard badge row now shows real images instead of a text list; verified end-to-end in a real headless browser against the live Atlas DB with disposable test accounts (registered, exercised, then deleted). Each badge is worth 5 IVs — recorded now, spendable once the IV system (5.5) exists
- [x] **5.4** EV tools — EV spread shown (read-only) on the Pokémon detail page and DM roster panel; new `berry` bag pocket consolidates every berry regardless of effect (healing, status-cure, and the new EV-reducing six — Pomeg/Kelpsy/Qualot/Hondew/Grepa/Tamato); vitamins (HP Up–Carbos) activated as real `+10 EV` items via `applyEvGain`; PP Up/PP Max implemented as the actual max-PP-boost mechanic (`ppUps` field per move, not an EV item as originally miscategorized); EVs wired into `computeStats()` (now takes a required `evs` argument, ~43 call sites updated) and into `@smogon/calc`'s damage formula via a new `toCalcEvs()` mapper — EVs now genuinely affect max HP, catch odds, speed order, and battle damage dealt/taken, not just cosmetic display; DM EV panel (`PATCH /api/dm/pokemon/:pokemonId/evs`) lets a DM set a Pokémon's full spread directly from `DmPlayersPage`
- [x] **5.5** Trainer IV activation — reworked from the originally-planned single flat +20 stat choice into a distributable point-buy system: every trainer earns an uncapped, always-growing IV pool (`badges.length × 5`) and can freely split points across any of the 6 stats, one point at a time, via `POST /api/auth/trainer-stat`; points lock in once spent, DM-only reset (`DELETE /api/dm/players/:username/trainer-stat`) clears the whole spread; `User.trainerStats` (an existing-but-unused Map field from milestone 2.1) stores the spent spread, `lib/trainerIv.ts` derives the pool/unspent/normalized-spread math; `computeStats()` gained a required 5th `ivs` argument threaded through ~60 call sites across non-battle bookkeeping (item heals, Rare Candy, starter creation, the shared level-up loop) and live battle turn resolution (end-of-round damage, turn-order speed sort, recoil/drain, Leech Seed, Pain Split, Curse, Protect chip damage, contact abilities); `@smogon/calc`'s damage formula and the DM "optimal" NPC AI both receive real IVs via a new `toCalcIvs()` mapper, replacing the old always-zero `ZERO_STATS` (removed, now dead). NPC/wild Pokémon never carry a bonus. Dashboard shows a "+1" allocator per stat; DM panel shows the full spread + unspent count with a two-step-confirm reset
- [x] **5.6** PvP battles — built in 5 submilestones: (1) **Data model & creation** — DM creates a pvp battle by picking two rosters of campaign players (`playerIds` = Team A, `enemyPlayerIds` = Team B, no overlap allowed); `enemySide` entries gained optional `userId`/`usedPokemonIds` so a pvp opponent's entries are structurally identical to `playerSide`'s; `playerPokemonLimit` reused symmetrically for both sides (no second limit field). (2) **Send-out & move/switch/item submission for both sides** — `findOwnSideEntry(battle, userId)` resolves "which side does this user act on" (checks `playerSide` then `enemySide`), used by `sendOut`/`submitMove`/`resolveSwitch` instead of assuming `playerSide`; `checkAndAdvance` now requires every pvp `enemySide` slot to send out and submit before advancing; `getActiveBattle` checks both sides. (3) **Targeting & turn resolution validation** — fixed the `actorType === 'player'` ≠ "on playerSide" conflation in `submitTarget`'s target-validity check and Fake Out's switch-in check (both now resolve the actor's real side instead of branching on actorType). (4) **Battle end conditions & rewards** — `isTrainerSideEliminated(entries, pokemonLimit)` extracted so pvp applies the same "any usable Pokémon left" rule to `enemySide`; EXP/EVs awarded to **both** sides via `awardExpToSide` (each side gains from the other's fainted Pokémon); no money changes hands in pvp under any circumstance; `Battle.winningSide` records the result since the shared turn log can't say "you win" from one perspective. (5) **Frontend** — `CreateBattleCard` gained a real Team B picker (previously a dead dropdown option); `BattlePage`'s `myEntry`/`mySide` resolve from either side (previously a pvp participant on `enemySide` saw a fully broken page since nothing matched); DM's NPC-actions panel suppressed for pvp; bottom side cards relabeled "Your Team"/"Opponent Team" and given a pvp-specific render branch; personalized win/loss banner via `winningSide`. DM still creates/starts/advances/sets-weather for pvp battles — same referee role as pve/wild, just never submits moves for either side. **Post-milestone addition:** NPC (pve) battle money rewards — DM sets an optional `moneyReward` at battle/encounter creation (pve only); `awardBattleMoney` pays the full amount to every `playerSide` trainer on victory (not split, not scaled by participation), guarded by `moneyAwarded`
- [x] **5.7** TM/HM system — built in 5 submilestones: (1) **TM/HM move catalog** — `backend/src/scripts/buildTmHmCatalog.ts`, a one-time build script, swept all 937 PokeAPI moves and baked the 358 that have ever been a real TM/HM (non-empty `machines` array) into a static `TM_HM_MOVES` catalog in `lib/tmHmData.ts`, same pattern as the badge catalog — zero runtime PokeAPI calls needed to validate a move. (2) **Species compatibility cache** — `fetchSpecies()` gained `machineMoves: string[]` per species (mirrors `levelUpMoves`, no level attached) and its move-detail fetch was expanded from level-up-only to the union of level-up + machine moves, since battle resolution looks up cached move data by name and a TM-taught move with no cached detail would silently fail to resolve; `PokedexCache`'s existing auto-refresh-on-touch backfill (`resolveSpeciesDoc` in `dmController.ts`) extended to cover species cached before this field existed. (3) **Item scaffolding + bulk give** — new `tm_hm` pocket; itemId synthesized as `tm-<moveId>` and resolved by prefix in `getPocket()` rather than an exhaustive map entry; `resolveItemPocket` validates the move against the 5.7a catalog; new general-purpose `POST /api/dm/campaign/items/give` gives any item (not just TM/HM) to every player in the DM's active campaign at once, each getting their own independent `Item` doc via the same upsert `givePlayerItem` already used. (4) **Teach mechanic** — `PATCH /api/pokemon/:id/teach-tm` (player self-service, mirrors `replaceMoveSlot`/Move Reminder) validates the bag (via `pokemon.ownerId`, not necessarily the caller) and `machineMoves`, swaps a slot, and — the one genuinely new rule in the whole item system — never decrements item quantity (Gen 8+ unlimited-use TMs). (5) **Frontend** — `BagPage.tsx` gained a TM/HM tab reusing the existing two-step Ether/PP-Up move-picker flow (branches to `teach-tm` instead of `/api/items/use`, no PP-based disabling); `DmPage.tsx`'s `GiveItemCard` gained a client-side-filtered TM/HM search picker (fetches the ~360-entry catalog once via new `GET /api/dm/tm-hm-moves`) and a "give to whole campaign" checkbox. Verified end-to-end via live HTTP requests against the real Atlas DB with disposable test accounts: fake-TM rejection, bulk-give, species-incompatible-TM rejection, successful teach with unchanged bag quantity, and — the critical case — a real battle turn where Toxic (TM-only for Bulbasaur, not learnable by leveling) actually resolves instead of silently no-oping from missing cached move data
- [x] **5.8** Admin panel — built in 5 submilestones: (1) **Foundation** — admin-only `/admin` route (`RequireAdmin`, stricter than the shared DM-or-admin `RequireDm`), `GET /api/admin/users` lists every account (role, email, resolved campaign name — a player's `currentCampaignId` or a DM's own active campaign found by `dmId`). (2) **Role management** — `PATCH .../:id/role`, guarded against self-demotion and demoting the last remaining admin. (3) **Delete user** — `DELETE .../:id` cascades the target's own Pokémon/Items and campaign membership; blocks deleting a DM whose active campaign still has other players; otherwise cascades the whole campaign tree (NPCs, NPC-owned Pokémon/Items, Encounters, Battles) along with it. (4) **Pokédex cache management** — `GET /api/admin/pokedex` search + `POST .../:id/refresh` force re-fetch from PokeAPI, overwriting every derived field. (5) **Bulk cleanup** — `POST /api/admin/users/bulk-delete` sweeps every username matching a ≥3-character pattern (admin accounts always skipped) via the same `cascadeDeleteUser()` cascade, built specifically for the leftover `verify*`/`tmdm*`/`tmplayer*` test accounts from past live-verification passes; frontend previews the exact match list before confirming. Also fixed a pre-existing security hole found along the way: `POST /api/auth/register` no longer accepts a client-supplied `role` (previously anyone could self-register as admin with no authentication).
- [x] **5.9** Dark mode — `ThemeProvider`/`useTheme`/`ThemeToggle` (light/dark, `localStorage`-persisted, defaults to `prefers-color-scheme`, no flash-of-wrong-theme via an inline `index.html` script); floating toggle button at `bottom-4 right-4` (no shared nav bar exists yet to dock it in); color audit added `dark:` variants to genuinely-broken hardcoded-color badges/banners across `BattlePage`, `DashboardPage`, `PokemonDetailPage`, `DmPlayersPage`, `BagPage`, and consolidated the 5x-duplicated `TYPE_BG` map into `lib/typeColors.ts`. Verified live with Playwright (installed fresh for this session) against a real login + a disposable test account on the live Atlas DB. Along the way: set up LAN-accessible dev servers so the app could be tested on a real phone (see Conventions Established), fixed a real bug where battle-log "super effective"/"not very effective" messages had never once fired due to string-matching a phrase `@smogon/calc` never produces (see Key Decisions), and fixed a toggle/Log-out button overlap the user found while testing on their phone. Originally scoped as "Mobile polish" (touch targets, iOS Safari testing) — that work never happened this session and was redirected into a new deferred milestone, 5.14.
- [x] **5.10** Town/Field mode — built in 2 submilestones: (1) **Data model + DM toggle** — `Campaign.fieldModeEnabled` (default `false` = Town mode), `PATCH /api/campaigns/field-mode` (DM-only, `{ enabled: boolean }`), mirrors `setLevelCapEnabled` exactly; `getMine` returns it alongside `levelCapEnabled` so both DM and player pages get it for free from the fetch they already make; DM panel's Campaign card gained a Town/Field toggle button next to the level-cap one. (2) **Player-side route gating** — `RequireTownMode` guard component in `App.tsx` (same shape as `RequireDm`/`RequireAdmin`) wraps `/pc` and `/town`; fetches `GET /api/campaigns/mine` for `role === 'player'` only (DMs/admins have no player character, so they pass through unchecked) and `<Navigate>`s to `/dashboard` with `state.blockedMessage` when `fieldModeEnabled` is true; `DashboardPage` reads `location.state.blockedMessage` and shows an amber banner (with `dark:` variant) when present. Verified live by the user (DM toggled Field mode, player was bounced from `/pc`/`/town` with the message shown).
- [ ] **5.11** Pokémart — build out the existing Town page stub (`frontend/src/pages/TownPage.tsx`, currently "Coming soon — shop for items.") into a real item shop players spend `User.money` in. Design/implementation deferred — scope TBD when picked up.
- [ ] **5.12** NPC held-item drops — auto-assign a held item to every NPC-owned Pokémon (both `Npc.type: 'wild'` and `Npc.type: 'trainer'` parties). When a player faints a Pokémon belonging to a `'wild'`-type NPC, that held item is given to the player (loot drop). Trainer-type NPCs' Pokémon also get held items (battle flavor/mechanics, consistent with the existing `heldItem` field + `held_type` item category), but those are never dropped to the player on faint. Design/implementation deferred — scope TBD when picked up.
- [ ] **5.13** Remaining moves + abilities — implement whatever is still flagged `implemented: false`. Moves: the esoteric cut list from Key Decisions (Attract, Helping Hand, Baton Pass, Metronome, Transform, Sketch, Copycat, Me First, Counter, Mirror Coat, Metal Burst, Roar, Whirlwind, Dragon Tail, Trick Room, Magic Room, Wonder Room, Follow Me, Rage Powder, Wide Guard, Quick Guard, Heal Pulse, Aromatic Mist, all binding/trapping moves, etc.) plus anything else PokeAPI-cached with `implemented: false` that isn't on that list. Abilities: whatever is still cached with `implemented: false` on `PokedexCache.abilities` (including hidden abilities — `hasHiddenAbility` on Pokemon already supports selecting them, this is about the *ability effects themselves* being coded), beyond what 4.8/4.9's ability engine already covers. Design/implementation deferred — scope TBD when picked up (likely needs sub-splitting by move/ability category, similar to how 4.4–4.12 broke move effects into waves).
- [ ] **5.14** Mobile polish — the original scope of 5.9 before it got redirected into dark mode: touch-target audit + fixes across every page (every interactive element ≥ 44×44px per the Mobile-First Rules), iOS Safari input-zoom fix (font-size ≥16px on all text/number inputs), safe-area-inset handling for the notch/home-indicator (`viewport-fit=cover` + `env(safe-area-inset-*)`), and a live device-testing pass on real iOS Safari + Android Chrome. Design/implementation deferred — scope TBD when picked up.
- [ ] **5.15** Battle replay — turn log replayable from beginning

---

## Current Milestone

- **Starting:** 5.11 — Pokémart
- **Just finished:** 5.10 — Town/Field mode (campaign-scoped DM toggle + player route gating on `/pc` and `/town`) — see Completed Milestones for full detail.
- **Known issues / blockers:** the live sweep of leftover `verify*`/`tmdm*`/`tmplayer*` test accounts (the reason 5.8e was built) still hasn't been run — blocked on a live admin bearer token from the user, same as before. The disposable `verifydarkmode<timestamp>` account created to test 5.9 live adds one more to that pile, matching the same `verify*` pattern so it'll get swept in the same pass.
- **Backlog (not yet started):** 5.12 NPC held-item drops, 5.13 remaining moves/abilities, 5.14 Mobile polish (5.9's original scope, redirected), 5.15 Battle replay (reordered after the others per 2026-08-07 planning discussion).

---

## Deferred / End-of-Project Fixes

- **Local sprites** — Pokémon images load from `https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/${speciesId}.png`. On machines behind a proxy that requires authentication, incognito/fresh browser sessions get `net::ERR_TUNNEL_CONNECTION_FAILED 407` (regular sessions work because proxy credentials are cached). Fix: download all sprite PNGs from the PokeAPI/sprites GitHub repo into `frontend/public/sprites/pokemon/` and change all image `src` attributes to `/sprites/pokemon/${speciesId}.png`. Affects: DashboardPage, PartyPage, BagPage, PCPage, PokemonDetailPage, DmPage, StarterPage.

---

## How to Use This File

1. Check off milestones as you complete them (`- [x]`)
2. Run the end-of-milestone git routine before closing each session
3. Add to **Conventions Established** as patterns emerge during coding
4. Update **Current Milestone** section before closing each session
