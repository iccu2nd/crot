import assert from 'node:assert/strict'
import test from 'node:test'
import { isGif, isPremiumSql, premiumXp } from '../src/core/premium.js'
import { PremiumService } from '../src/services/premium.js'

test('bonus XP premium dibulatkan ke atas', () => {
  assert.deepEqual([10, 5, 3, 1].map(premiumXp), [15, 8, 5, 2])
  assert.match(isPremiumSql('u'), /u\.premium OR .*u\.premium_until > now\(\)/)
})

test('GIF dikenali dari header, bukan dari nama/tipe kiriman', () => {
  assert.ok(isGif(Buffer.from('GIF89a0123456789')))
  assert.ok(!isGif(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5, 6, 7, 8])))
})

test('tampilan profil: mengubah khusus Premium, mengosongkan boleh siapa saja, id tak dikenal ditolak', async () => {
  const calls: any[] = []
  const svc = new PremiumService({ async query(_s: string, p: any[]) { calls.push(p); return { rows: [] } } } as any)
  await assert.rejects(svc.setStyle(1, false, { frame: 'gold' }), /khusus Premium/)
  await assert.rejects(svc.setStyle(1, false, { headerBlur: 5 }), /khusus Premium/)
  await svc.setStyle(1, false, { frame: '', theme: null }) // kosongkan = boleh
  await svc.setStyle(1, true, { frame: 'neon', headerBlur: 12, headerPos: 30 })
  assert.deepEqual(calls.at(-1), [1, false, null, true, 'neon', true, 12, true, 30])
  await assert.rejects(svc.setStyle(1, true, { theme: 'hack' }), /Tema tidak valid/)
  await assert.rejects(svc.setStyle(1, true, { headerBlur: 99 }), /Blur/)
  await assert.rejects(svc.setStyle(1, true, {}), /Tidak ada perubahan/)
})
