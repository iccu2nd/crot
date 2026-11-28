import assert from 'node:assert/strict'
import test from 'node:test'
import { isPremiumSql, premiumXp } from '../src/core/premium.js'
import { PremiumService } from '../src/services/premium.js'

test('bonus XP premium dibulatkan ke atas', () => {
  assert.deepEqual([10, 5, 3, 1].map(premiumXp), [15, 8, 5, 2])
  assert.match(isPremiumSql('u'), /u\.premium OR .*u\.premium_until > now\(\)/)
})

test('tampilan profil: mengubah khusus Premium, mengosongkan boleh siapa saja, id tak dikenal ditolak', async () => {
  const calls: any[] = []
  const svc = new PremiumService({ async query(_s: string, p: any[]) { calls.push(p); return { rows: [] } } } as any)
  await assert.rejects(svc.setStyle(1, false, { frame: 'gold' }), /khusus Premium/)
  await svc.setStyle(1, false, { frame: '', theme: null })
  await svc.setStyle(1, true, { frame: 'neon' })
  assert.deepEqual(calls.at(-1), [1, false, null, true, 'neon'])
  await assert.rejects(svc.setStyle(1, true, { theme: 'hack' }), /Tema tidak valid/)
  await assert.rejects(svc.setStyle(1, true, {}), /Tidak ada perubahan/)
})
