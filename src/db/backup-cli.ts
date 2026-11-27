import { config } from '../config.js'
import { BackupService } from '../services/storage/backup.js'
import { createPool } from './pool.js'

const pool = createPool(config)
try {
  const result = await new BackupService(pool, config.storage.backup).create()
  console.log(`Backup dibuat: ${result.name} (${result.bytes} byte)`)
  console.log(JSON.stringify(result.counts))
} catch (e) {
  console.error((e as Error).message)
  process.exitCode = 1
} finally {
  await pool.end()
}
