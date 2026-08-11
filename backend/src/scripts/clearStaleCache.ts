// One-off dev script — deletes named PokedexCache entries so the next request
// re-fetches fresh from PokeAPI. Used here to pick up the level_learned_at===0
// fix in pokeapi.ts for species already cached before that fix.
// Usage: npx tsc && node dist/scripts/clearStaleCache.js <name1> <name2> ...
import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
dotenv.config();

async function main() {
  const names = process.argv.slice(2);
  await mongoose.connect(process.env.MONGODB_URI as string);
  const result = await mongoose.connection.collection('pokedexcaches').deleteMany({ name: { $in: names } });
  console.log(`Deleted ${result.deletedCount} cache entries for: ${names.join(', ')}`);
  await mongoose.disconnect();
}

main().catch(err => { console.error(err); process.exit(1); });
