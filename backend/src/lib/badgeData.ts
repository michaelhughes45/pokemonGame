// ---------------------------------------------------------------------------
// Hardcoded catalog of official main-series Pokémon gym badges.
// Verified against Bulbapedia (https://bulbapedia.bulbagarden.net/wiki/Badge)
// and the Bulbagarden Archives image database. Images are downloaded locally
// into frontend/public/badges/{region-slug}/{badge-id}.png — do not hotlink.
//
// Regions in scope: Kanto, Johto, Hoenn, Sinnoh, Unova (Black/White only —
// Black 2/White 2's different gym lineup is intentionally excluded), Kalos,
// Galar (all Sword/Shield version-exclusive variants included), Paldea.
// Alola is excluded — it has trial stamps, not gym badges.
// Galar DLC (Isle of Armor / Crown Tundra) verified on Bulbapedia to NOT
// grant any League-recognized gym badges, so no DLC entries are included.
//
// badgeId is prefixed with region because several badge names repeat across
// regions (e.g. Fairy Badge exists in both Kalos and Galar) — badgeId must
// stay globally unique since it's the key stored on User.badges once
// award/revoke lands.
// ---------------------------------------------------------------------------

export type BadgeCatalogEntry = {
  badgeId: string;       // globally unique, kebab-case: {region}-{badge-name}
  name: string;          // display name, e.g. "Boulder Badge"
  region: string;        // e.g. "Kanto"
  imageUrl: string;      // local path served by the frontend, e.g. "/badges/kanto/boulder-badge.png"
  gymLeader?: string;    // optional flavor: the leader who awards it, if easily available
  versionExclusive?: string; // only set for Galar's version-exclusive badges, e.g. "Sword" or "Shield"
};

export const BADGE_CATALOG: BadgeCatalogEntry[] = [
  // ── Kanto (Indigo League) ──────────────────────────────────────────────────
  { badgeId: 'kanto-boulder-badge', name: 'Boulder Badge', region: 'Kanto', imageUrl: '/badges/kanto/boulder-badge.png', gymLeader: 'Brock' },
  { badgeId: 'kanto-cascade-badge', name: 'Cascade Badge', region: 'Kanto', imageUrl: '/badges/kanto/cascade-badge.png', gymLeader: 'Misty' },
  { badgeId: 'kanto-thunder-badge', name: 'Thunder Badge', region: 'Kanto', imageUrl: '/badges/kanto/thunder-badge.png', gymLeader: 'Lt. Surge' },
  { badgeId: 'kanto-rainbow-badge', name: 'Rainbow Badge', region: 'Kanto', imageUrl: '/badges/kanto/rainbow-badge.png', gymLeader: 'Erika' },
  { badgeId: 'kanto-soul-badge', name: 'Soul Badge', region: 'Kanto', imageUrl: '/badges/kanto/soul-badge.png', gymLeader: 'Koga' },
  { badgeId: 'kanto-marsh-badge', name: 'Marsh Badge', region: 'Kanto', imageUrl: '/badges/kanto/marsh-badge.png', gymLeader: 'Sabrina' },
  { badgeId: 'kanto-volcano-badge', name: 'Volcano Badge', region: 'Kanto', imageUrl: '/badges/kanto/volcano-badge.png', gymLeader: 'Blaine' },
  { badgeId: 'kanto-earth-badge', name: 'Earth Badge', region: 'Kanto', imageUrl: '/badges/kanto/earth-badge.png', gymLeader: 'Giovanni' },

  // ── Johto (Johto League) ───────────────────────────────────────────────────
  { badgeId: 'johto-zephyr-badge', name: 'Zephyr Badge', region: 'Johto', imageUrl: '/badges/johto/zephyr-badge.png', gymLeader: 'Falkner' },
  { badgeId: 'johto-hive-badge', name: 'Hive Badge', region: 'Johto', imageUrl: '/badges/johto/hive-badge.png', gymLeader: 'Bugsy' },
  { badgeId: 'johto-plain-badge', name: 'Plain Badge', region: 'Johto', imageUrl: '/badges/johto/plain-badge.png', gymLeader: 'Whitney' },
  { badgeId: 'johto-fog-badge', name: 'Fog Badge', region: 'Johto', imageUrl: '/badges/johto/fog-badge.png', gymLeader: 'Morty' },
  { badgeId: 'johto-storm-badge', name: 'Storm Badge', region: 'Johto', imageUrl: '/badges/johto/storm-badge.png', gymLeader: 'Chuck' },
  { badgeId: 'johto-mineral-badge', name: 'Mineral Badge', region: 'Johto', imageUrl: '/badges/johto/mineral-badge.png', gymLeader: 'Jasmine' },
  { badgeId: 'johto-glacier-badge', name: 'Glacier Badge', region: 'Johto', imageUrl: '/badges/johto/glacier-badge.png', gymLeader: 'Pryce' },
  { badgeId: 'johto-rising-badge', name: 'Rising Badge', region: 'Johto', imageUrl: '/badges/johto/rising-badge.png', gymLeader: 'Clair' },

  // ── Hoenn (Hoenn League) ───────────────────────────────────────────────────
  { badgeId: 'hoenn-stone-badge', name: 'Stone Badge', region: 'Hoenn', imageUrl: '/badges/hoenn/stone-badge.png', gymLeader: 'Roxanne' },
  { badgeId: 'hoenn-knuckle-badge', name: 'Knuckle Badge', region: 'Hoenn', imageUrl: '/badges/hoenn/knuckle-badge.png', gymLeader: 'Brawly' },
  { badgeId: 'hoenn-dynamo-badge', name: 'Dynamo Badge', region: 'Hoenn', imageUrl: '/badges/hoenn/dynamo-badge.png', gymLeader: 'Wattson' },
  { badgeId: 'hoenn-heat-badge', name: 'Heat Badge', region: 'Hoenn', imageUrl: '/badges/hoenn/heat-badge.png', gymLeader: 'Flannery' },
  { badgeId: 'hoenn-balance-badge', name: 'Balance Badge', region: 'Hoenn', imageUrl: '/badges/hoenn/balance-badge.png', gymLeader: 'Norman' },
  { badgeId: 'hoenn-feather-badge', name: 'Feather Badge', region: 'Hoenn', imageUrl: '/badges/hoenn/feather-badge.png', gymLeader: 'Winona' },
  { badgeId: 'hoenn-mind-badge', name: 'Mind Badge', region: 'Hoenn', imageUrl: '/badges/hoenn/mind-badge.png', gymLeader: 'Tate and Liza' },
  { badgeId: 'hoenn-rain-badge', name: 'Rain Badge', region: 'Hoenn', imageUrl: '/badges/hoenn/rain-badge.png', gymLeader: 'Wallace' },

  // ── Sinnoh (Sinnoh League) ─────────────────────────────────────────────────
  { badgeId: 'sinnoh-coal-badge', name: 'Coal Badge', region: 'Sinnoh', imageUrl: '/badges/sinnoh/coal-badge.png', gymLeader: 'Roark' },
  { badgeId: 'sinnoh-forest-badge', name: 'Forest Badge', region: 'Sinnoh', imageUrl: '/badges/sinnoh/forest-badge.png', gymLeader: 'Gardenia' },
  { badgeId: 'sinnoh-cobble-badge', name: 'Cobble Badge', region: 'Sinnoh', imageUrl: '/badges/sinnoh/cobble-badge.png', gymLeader: 'Maylene' },
  { badgeId: 'sinnoh-fen-badge', name: 'Fen Badge', region: 'Sinnoh', imageUrl: '/badges/sinnoh/fen-badge.png', gymLeader: 'Crasher Wake' },
  { badgeId: 'sinnoh-relic-badge', name: 'Relic Badge', region: 'Sinnoh', imageUrl: '/badges/sinnoh/relic-badge.png', gymLeader: 'Fantina' },
  { badgeId: 'sinnoh-mine-badge', name: 'Mine Badge', region: 'Sinnoh', imageUrl: '/badges/sinnoh/mine-badge.png', gymLeader: 'Byron' },
  { badgeId: 'sinnoh-icicle-badge', name: 'Icicle Badge', region: 'Sinnoh', imageUrl: '/badges/sinnoh/icicle-badge.png', gymLeader: 'Candice' },
  { badgeId: 'sinnoh-beacon-badge', name: 'Beacon Badge', region: 'Sinnoh', imageUrl: '/badges/sinnoh/beacon-badge.png', gymLeader: 'Volkner' },

  // ── Unova (Pokémon Black/White only — not Black 2/White 2) ────────────────
  { badgeId: 'unova-trio-badge', name: 'Trio Badge', region: 'Unova', imageUrl: '/badges/unova/trio-badge.png', gymLeader: 'Cilan, Chili, and Cress' },
  { badgeId: 'unova-basic-badge', name: 'Basic Badge', region: 'Unova', imageUrl: '/badges/unova/basic-badge.png', gymLeader: 'Lenora' },
  { badgeId: 'unova-insect-badge', name: 'Insect Badge', region: 'Unova', imageUrl: '/badges/unova/insect-badge.png', gymLeader: 'Burgh' },
  { badgeId: 'unova-bolt-badge', name: 'Bolt Badge', region: 'Unova', imageUrl: '/badges/unova/bolt-badge.png', gymLeader: 'Elesa' },
  { badgeId: 'unova-quake-badge', name: 'Quake Badge', region: 'Unova', imageUrl: '/badges/unova/quake-badge.png', gymLeader: 'Clay' },
  { badgeId: 'unova-jet-badge', name: 'Jet Badge', region: 'Unova', imageUrl: '/badges/unova/jet-badge.png', gymLeader: 'Skyla' },
  { badgeId: 'unova-freeze-badge', name: 'Freeze Badge', region: 'Unova', imageUrl: '/badges/unova/freeze-badge.png', gymLeader: 'Brycen' },
  { badgeId: 'unova-legend-badge', name: 'Legend Badge', region: 'Unova', imageUrl: '/badges/unova/legend-badge.png', gymLeader: 'Iris' },

  // ── Kalos (Kalos League) ───────────────────────────────────────────────────
  { badgeId: 'kalos-bug-badge', name: 'Bug Badge', region: 'Kalos', imageUrl: '/badges/kalos/bug-badge.png', gymLeader: 'Viola' },
  { badgeId: 'kalos-cliff-badge', name: 'Cliff Badge', region: 'Kalos', imageUrl: '/badges/kalos/cliff-badge.png', gymLeader: 'Grant' },
  { badgeId: 'kalos-rumble-badge', name: 'Rumble Badge', region: 'Kalos', imageUrl: '/badges/kalos/rumble-badge.png', gymLeader: 'Korrina' },
  { badgeId: 'kalos-plant-badge', name: 'Plant Badge', region: 'Kalos', imageUrl: '/badges/kalos/plant-badge.png', gymLeader: 'Ramos' },
  { badgeId: 'kalos-voltage-badge', name: 'Voltage Badge', region: 'Kalos', imageUrl: '/badges/kalos/voltage-badge.png', gymLeader: 'Clemont' },
  { badgeId: 'kalos-fairy-badge', name: 'Fairy Badge', region: 'Kalos', imageUrl: '/badges/kalos/fairy-badge.png', gymLeader: 'Valerie' },
  { badgeId: 'kalos-psychic-badge', name: 'Psychic Badge', region: 'Kalos', imageUrl: '/badges/kalos/psychic-badge.png', gymLeader: 'Olympia' },
  { badgeId: 'kalos-iceberg-badge', name: 'Iceberg Badge', region: 'Kalos', imageUrl: '/badges/kalos/iceberg-badge.png', gymLeader: 'Wikstrom' },

  // ── Galar (Pokémon Sword and Shield) ───────────────────────────────────────
  // Stow-on-Side and Circhester each have a Sword-exclusive and a
  // Shield-exclusive gym leader/badge; both variants are included below.
  { badgeId: 'galar-grass-badge', name: 'Grass Badge', region: 'Galar', imageUrl: '/badges/galar/grass-badge.png', gymLeader: 'Milo' },
  { badgeId: 'galar-water-badge', name: 'Water Badge', region: 'Galar', imageUrl: '/badges/galar/water-badge.png', gymLeader: 'Nessa' },
  { badgeId: 'galar-fire-badge', name: 'Fire Badge', region: 'Galar', imageUrl: '/badges/galar/fire-badge.png', gymLeader: 'Kabu' },
  { badgeId: 'galar-fighting-badge', name: 'Fighting Badge', region: 'Galar', imageUrl: '/badges/galar/fighting-badge.png', gymLeader: 'Bea', versionExclusive: 'Sword' },
  { badgeId: 'galar-ghost-badge', name: 'Ghost Badge', region: 'Galar', imageUrl: '/badges/galar/ghost-badge.png', gymLeader: 'Allister', versionExclusive: 'Shield' },
  { badgeId: 'galar-fairy-badge', name: 'Fairy Badge', region: 'Galar', imageUrl: '/badges/galar/fairy-badge.png', gymLeader: 'Opal' },
  { badgeId: 'galar-rock-badge', name: 'Rock Badge', region: 'Galar', imageUrl: '/badges/galar/rock-badge.png', gymLeader: 'Gordie', versionExclusive: 'Sword' },
  { badgeId: 'galar-ice-badge', name: 'Ice Badge', region: 'Galar', imageUrl: '/badges/galar/ice-badge.png', gymLeader: 'Melony', versionExclusive: 'Shield' },
  { badgeId: 'galar-dark-badge', name: 'Dark Badge', region: 'Galar', imageUrl: '/badges/galar/dark-badge.png', gymLeader: 'Piers' },
  { badgeId: 'galar-dragon-badge', name: 'Dragon Badge', region: 'Galar', imageUrl: '/badges/galar/dragon-badge.png', gymLeader: 'Raihan' },

  // ── Paldea (Pokémon Scarlet and Violet) ────────────────────────────────────
  { badgeId: 'paldea-bug-badge', name: 'Bug Badge', region: 'Paldea', imageUrl: '/badges/paldea/bug-badge.png', gymLeader: 'Katy' },
  { badgeId: 'paldea-grass-badge', name: 'Grass Badge', region: 'Paldea', imageUrl: '/badges/paldea/grass-badge.png', gymLeader: 'Brassius' },
  { badgeId: 'paldea-electric-badge', name: 'Electric Badge', region: 'Paldea', imageUrl: '/badges/paldea/electric-badge.png', gymLeader: 'Iono' },
  { badgeId: 'paldea-water-badge', name: 'Water Badge', region: 'Paldea', imageUrl: '/badges/paldea/water-badge.png', gymLeader: 'Kofu' },
  { badgeId: 'paldea-normal-badge', name: 'Normal Badge', region: 'Paldea', imageUrl: '/badges/paldea/normal-badge.png', gymLeader: 'Larry' },
  { badgeId: 'paldea-ghost-badge', name: 'Ghost Badge', region: 'Paldea', imageUrl: '/badges/paldea/ghost-badge.png', gymLeader: 'Ryme' },
  { badgeId: 'paldea-psychic-badge', name: 'Psychic Badge', region: 'Paldea', imageUrl: '/badges/paldea/psychic-badge.png', gymLeader: 'Tulip' },
  { badgeId: 'paldea-ice-badge', name: 'Ice Badge', region: 'Paldea', imageUrl: '/badges/paldea/ice-badge.png', gymLeader: 'Grusha' },
];
