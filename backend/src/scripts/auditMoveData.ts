// ---------------------------------------------------------------------------
// One-time audit script — NOT run by the server.
// Sweeps every move in PokeAPI and diffs its real ailment/stat-change/flinch/
// drain/multi-hit/priority data against what's currently hardcoded in
// backend/src/lib/moveData.ts, to find milestone 5.14 Wave 1 gaps (missing
// table entries) plus any stale/incorrect entries already present.
//
// Does NOT write to moveData.ts — outputs a JSON report for manual review
// and curation, since project-specific judgment calls (toxic vs poison,
// which of the 7 supported statuses/confusion apply, PokeAPI stat-name ->
// this project's StatStages key mapping, Mega/Z/G-Max/Shadow move exclusion)
// aren't safe to fully automate.
//
// Usage: npx tsc && node dist/scripts/auditMoveData.js
// ---------------------------------------------------------------------------

import * as fs from 'fs';
import * as path from 'path';
import {
  STATUS_MOVES,
  STAT_STAGE_MOVES,
  FLINCH_MOVES,
  RECOIL_MOVES,
  DRAIN_MOVES,
  MULTI_HIT_MOVES,
  MOVE_PRIORITY,
} from '../lib/moveData';

const CONCURRENCY = 20;

async function fetchJson(url: string, retries = 4): Promise<any> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`Fetch failed (${res.status}): ${url}`);
      return await res.json();
    } catch (err) {
      if (attempt === retries) throw err;
      await new Promise(r => setTimeout(r, 500 * (attempt + 1)));
    }
  }
}

// PokeAPI ailment names this project actually models as a status condition.
// Anything else (trap, nightmare, torment, disable, yawn, heal-block, ingrain,
// leech-seed, embargo, perish-song, silence, no-type-immunity, infatuation,
// none, unknown) is a distinct volatile/mechanic already tracked separately
// (or a later 5.14 wave / genuinely out of scope) — not a STATUS_MOVES gap.
const AILMENT_TO_STATUS: Record<string, string> = {
  paralysis: 'paralysis',
  burn: 'burn',
  freeze: 'freeze',
  poison: 'poison', // 'toxic' move is special-cased separately below
  confusion: 'confusion',
};

async function main() {
  console.log('Fetching move list...');
  const list = await fetchJson('https://pokeapi.co/api/v2/move?limit=1');
  const total = list.count as number;
  const allMoves = await fetchJson(`https://pokeapi.co/api/v2/move?limit=${total}&offset=0`);
  const urls: string[] = allMoves.results.map((m: any) => m.url);
  console.log(`Found ${urls.length} moves. Fetching full detail...`);

  const details: any[] = [];
  let checked = 0;
  for (let i = 0; i < urls.length; i += CONCURRENCY) {
    const batch = urls.slice(i, i + CONCURRENCY);
    const batchDetails = await Promise.all(batch.map(url => fetchJson(url)));
    details.push(...batchDetails);
    checked += batch.length;
    if (checked % 100 === 0 || checked === urls.length) {
      console.log(`  ${checked}/${urls.length} fetched`);
    }
  }

  const statusMissing: any[] = [];
  const statusStale: any[] = [];
  const statStageMissing: any[] = [];
  const flinchMissing: any[] = [];
  const recoilDrainMissing: any[] = [];
  const multiHitMissing: any[] = [];
  const priorityMissing: any[] = [];
  const priorityStale: any[] = [];

  const STAT_NAME_MAP: Record<string, string> = {
    attack: 'atk',
    defense: 'def',
    'special-attack': 'spa',
    'special-defense': 'spd',
    speed: 'spe',
    accuracy: 'acc',
    evasion: 'eva',
  };

  for (const move of details) {
    const id: string = move.name;
    const meta = move.meta ?? {};
    const damageClass: string = move.damage_class?.name ?? 'unknown';

    // ---- Status ailments ----
    const ailmentName: string = meta.ailment?.name ?? 'none';
    const ailmentChance: number = meta.ailment_chance ?? 0;
    const mappedStatus = id === 'toxic' ? 'toxic' : AILMENT_TO_STATUS[ailmentName];
    if (mappedStatus) {
      // PokeAPI convention: ailment_chance === 0 means "always applies" for
      // primary-effect status moves (damage_class 'status'); nonzero means an
      // explicit percentage secondary effect on a damaging move.
      const chance = ailmentChance === 0 ? 1 : ailmentChance / 100;
      const existing = STATUS_MOVES[id];
      if (!existing) {
        statusMissing.push({ id, status: mappedStatus, chance, damageClass });
      } else if (existing.status !== mappedStatus || Math.abs(existing.chance - chance) > 0.001) {
        statusStale.push({ id, current: existing, real: { status: mappedStatus, chance } });
      }
    }

    // ---- Stat-change effects ----
    const statChanges: any[] = move.stat_changes ?? [];
    if (statChanges.length > 0) {
      const existing = STAT_STAGE_MOVES[id];
      const mappedChanges = statChanges
        .map((sc: any) => ({ stat: STAT_NAME_MAP[sc.stat.name] ?? sc.stat.name, stages: sc.change }))
        .filter((sc: any) => sc.stat in STAT_NAME_MAP === false ? true : true); // keep all, just annotate unmapped
      if (!existing) {
        statStageMissing.push({
          id,
          damageClass,
          target: move.target?.name,
          statChanges: mappedChanges,
          statChance: meta.stat_chance ?? 0,
        });
      }
    }

    // ---- Flinch ----
    const flinchChance: number = meta.flinch_chance ?? 0;
    if (flinchChance > 0 && !(id in FLINCH_MOVES)) {
      flinchMissing.push({ id, chance: flinchChance / 100 });
    }

    // ---- Recoil / Drain (meta.drain: positive = drain %, negative = recoil %) ----
    const drain: number = meta.drain ?? 0;
    if (drain !== 0 && !(id in RECOIL_MOVES) && !(id in DRAIN_MOVES)) {
      recoilDrainMissing.push({ id, drain, type: drain > 0 ? 'drain' : 'recoil', fraction: Math.abs(drain) / 100 });
    }

    // ---- Multi-hit ----
    const minHits: number | null = meta.min_hits ?? null;
    const maxHits: number | null = meta.max_hits ?? null;
    if (minHits && maxHits && !(id in MULTI_HIT_MOVES)) {
      multiHitMissing.push({ id, minHits, maxHits, fixed: minHits === maxHits });
    }

    // ---- Priority ----
    const priority: number = move.priority ?? 0;
    if (priority !== 0) {
      const existing = MOVE_PRIORITY[id];
      if (existing === undefined) {
        priorityMissing.push({ id, priority });
      } else if (existing !== priority) {
        priorityStale.push({ id, current: existing, real: priority });
      }
    }
  }

  const report = {
    generatedAt: new Date().toISOString(),
    totalMoves: urls.length,
    statusMissing: statusMissing.sort((a, b) => a.id.localeCompare(b.id)),
    statusStale,
    statStageMissing: statStageMissing.sort((a, b) => a.id.localeCompare(b.id)),
    flinchMissing: flinchMissing.sort((a, b) => a.id.localeCompare(b.id)),
    recoilDrainMissing: recoilDrainMissing.sort((a, b) => a.id.localeCompare(b.id)),
    multiHitMissing: multiHitMissing.sort((a, b) => a.id.localeCompare(b.id)),
    priorityMissing: priorityMissing.sort((a, b) => a.id.localeCompare(b.id)),
    priorityStale,
  };

  const outPath = path.join(__dirname, 'auditMoveData.report.json');
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2), 'utf-8');

  console.log('\n=== Summary ===');
  console.log(`STATUS_MOVES missing: ${statusMissing.length}, stale: ${statusStale.length}`);
  console.log(`STAT_STAGE_MOVES missing: ${statStageMissing.length}`);
  console.log(`FLINCH_MOVES missing: ${flinchMissing.length}`);
  console.log(`RECOIL/DRAIN missing: ${recoilDrainMissing.length}`);
  console.log(`MULTI_HIT_MOVES missing: ${multiHitMissing.length}`);
  console.log(`MOVE_PRIORITY missing: ${priorityMissing.length}, stale: ${priorityStale.length}`);
  console.log(`\nFull report written to ${outPath}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
