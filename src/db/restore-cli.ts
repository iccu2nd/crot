import { config } from '../config.js'
import { BackupService } from '../services/storage/backup.js'
import { createPool, migrate } from './pool.js'

const file = process.argv[2]
if (!file) {
  console.error('Pemakaian: npm run restore -- <berkas mitoon-*.ndjson.gz>')
  process.exit(1)
}

const pool = createPool(config)
try {
  const applied = await migrate(pool)
  if (applied.length) console.log(`Migrasi dijalankan: ${applied.join(', ')}`)
  const result = await new BackupService(pool, config.storage.backup).restore(file)
  console.log('Dibaca   :', JSON.stringify(result.read))
  console.log('Dimasukkan:', JSON.stringify(result.inserted))
} catch (e) {
  console.error((e as Error).message)
  process.exitCode = 1
} finally {
  await pool.end()
}
