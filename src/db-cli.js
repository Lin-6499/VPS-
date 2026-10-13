import { createPool,migrate,safeError } from './db.js';
import { Repository } from './repository.js';
import { Collector } from './collector.js';
const pool = createPool();
try {
  await migrate(pool);
  const repo = new Repository(pool);
  await repo.seed();
  if (process.argv.includes('--import')) {
    const results = await new Collector(repo).refresh();
    if (results.some(r => !r.ok)) throw new Error('Initial collection failed');
  }
  const [[summary]] = await pool.query('SELECT (SELECT COUNT(*) FROM devices) devices,(SELECT COUNT(*) FROM device_credentials) credentials,(SELECT COUNT(*) FROM nodes) nodes');
  console.log(JSON.stringify({database:process.env.DB_NAME,...summary}));
} catch (e) { console.error(safeError(e)); process.exitCode = 1; }
finally { await pool.end(); }
