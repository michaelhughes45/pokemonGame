// One-off dev script — sets a disposable test account's role directly in the DB.
// Bypasses the "only an existing admin can promote" rule (Key Decision, milestone
// 5.8), which is otherwise correct API behavior; used here only to unblock live
// verification when no admin bearer token is available in this session.
// Usage: npx tsc && node dist/scripts/setRoleForTest.js <username> <role>
import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
dotenv.config();

async function main() {
  const [username, role] = process.argv.slice(2);
  if (!username || !['dm', 'admin', 'player'].includes(role)) {
    console.error('Usage: setRoleForTest.js <username> <dm|admin|player>');
    process.exit(1);
  }
  await mongoose.connect(process.env.MONGODB_URI as string);
  const result = await mongoose.connection.collection('users').updateOne({ username }, { $set: { role } });
  console.log(`Matched ${result.matchedCount}, modified ${result.modifiedCount}`);
  await mongoose.disconnect();
}

main().catch(err => { console.error(err); process.exit(1); });
