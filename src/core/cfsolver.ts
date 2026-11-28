/**
 * Solver tantangan Cloudflare (browser sungguhan) untuk provider yang diblokir di IP datacenter.
 *
 * Alur (hemat dulu, berat belakangan):
 *  1. `solve(origin)`  : buka Chrome, lewati tantangan, simpan `cf_clearance` + User-Agent di memori (TTL).
 *                        Request berikutnya cukup `fetch` biasa dengan cookie itu (tanpa Chrome).
 *  2. `browserGet(url)`: bila cookie saja ditolak (mis. sidik jari TLS beda), ambil halaman lewat Chrome yang sama.
 *
 * Chrome dimuat malas (dynamic import) dan ditutup otomatis saat idle supaya RAM Railway tidak tertahan.
 * Dimatikan dengan env `CF_SOLVER=0`. Butuh paket `puppeteer-real-browser`, `chromium`, dan `xvfb` (lihat Dockerfile).
 */
import { NotFoundError, UpstreamError } from './errors.js'

export interface CfSession {
  host: string
  ua: string
  cookie: string
  at: number
  hasClearance: boolean
}

/** Error solver: `fatal` = percuma dicoba lagi lewat browser (mis. IP diblokir WAF). */
export class SolverError extends UpstreamError {
  constructor(message: string, readonly fatal = false) {
    super(message, 403)
  }
}

const num = (v: string | undefined, d: number) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d)
const TTL_MS = num(process.env.CF_SOLVER_TTL_MIN, 25) * 60_000
const COOLDOWN_MS = num(process.env.CF_SOLVER_COOLDOWN_SEC, 120) * 1000
const IDLE_MS = num(process.env.CF_SOLVER_IDLE_SEC, 90) * 1000
const TIMEOUT_MS = num(process.env.CF_SOLVER_TIMEOUT_SEC, 45) * 1000
const CHROME_PATH = process.env.CHROME_PATH || process.env.CHROME_BIN || ''

export const solverEnabled = () => process.env.CF_SOLVER !== '0'

const CHALLENGE = /just a moment|attention required|verify(?:ing)? you are human|enable javascript and cookies|cf-browser-verification/i
/** Blokir keras (WAF/IP), bukan tantangan yang bisa diselesaikan. */
const HARD_BLOCK = /sorry, you have been blocked|error 1020|error 1015|error 1006|error 1007|error 1008|access denied|you are being rate limited/i

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

const sessions = new Map<string, CfSession>()
let failedAt = 0
let inflight: Promise<CfSession> | null = null
let browserModeUntil = 0

/** Sesi tersimpan yang berlaku untuk host `url` (host sama atau subdomainnya). */
export function sessionFor(url: string): CfSession | undefined {
  let h: string
  try {
    h = new URL(url).hostname
  } catch {
    return undefined
  }
  const now = Date.now()
  for (const s of sessions.values()) {
    if (now - s.at > TTL_MS) continue
    if (h === s.host || h.endsWith('.' + s.host)) return s
  }
  return undefined
}

/** Setelah cookie terbukti tidak cukup, sementara langsung pakai browser (hindari 2 request gagal per panggilan). */
export const browserPreferred = () => Date.now() < browserModeUntil
export const preferBrowser = () => {
  browserModeUntil = Date.now() + TTL_MS
}

// ---------------------------------------------------------------- browser (malas, serial, auto-tutup)
type Handle = { browser: any; page: any }
let handle: Handle | null = null
let idleTimer: NodeJS.Timeout | null = null
let chain: Promise<unknown> = Promise.resolve()

/** Satu operasi browser pada satu waktu (satu halaman dipakai bersama). */
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn)
  chain = run.catch(() => undefined)
  return run
}

function touch() {
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = setTimeout(() => void closeBrowser(), IDLE_MS)
  idleTimer.unref?.()
}

export async function closeBrowser(): Promise<void> {
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = null
  const h = handle
  handle = null
  try {
    await h?.browser?.close()
  } catch {
    /* sudah tertutup */
  }
}

async function openBrowser(): Promise<Handle> {
  if (handle) return handle
  const spec = 'puppeteer-real-browser' // lewat variabel: paket opsional, tidak dibutuhkan saat kompilasi
  let mod: any
  try {
    mod = await import(spec)
  } catch (e) {
    throw new SolverError(`solver Cloudflare tidak tersedia: paket puppeteer-real-browser belum terpasang (${(e as Error).message})`, true)
  }
  const connect = mod.connect ?? mod.default?.connect
  if (typeof connect !== 'function') throw new SolverError('solver Cloudflare: API puppeteer-real-browser tidak dikenali', true)
  let r: any
  try {
    r = await connect({
      headless: false, // Linux: layar virtual lewat Xvfb (lebih lolos daripada headless)
      turnstile: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--window-size=1280,800'],
      customConfig: CHROME_PATH ? { chromePath: CHROME_PATH } : {},
      connectOption: { defaultViewport: { width: 1280, height: 800 } }
    })
  } catch (e) {
    throw new SolverError(`solver Cloudflare gagal membuka Chrome (${(e as Error).message}); pastikan chromium + xvfb terpasang dan CHROME_PATH benar`, true)
  }
  const h: Handle = { browser: r.browser, page: r.page }
  r.browser?.on?.('disconnected', () => {
    if (handle?.browser === r.browser) handle = null
  })
  handle = h
  return h
}

async function pageState(page: any): Promise<string> {
  const title = await page.title().catch(() => '')
  const text = await page.evaluate(() => document.body?.innerText?.slice(0, 800) || '').catch(() => '')
  return `${title}\n${text}`
}

/** Tunggu sampai tantangan hilang. Blokir keras langsung dilaporkan (tidak menunggu sampai timeout). */
async function waitClear(page: any, ms: number): Promise<void> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const st = await pageState(page)
    if (HARD_BLOCK.test(st) && /attention required|blocked|1020|access denied/i.test(st)) {
      throw new SolverError('Cloudflare memblokir IP server ini (WAF/error 1020); solver tidak membantu. Pakai proxy atau jalankan scraper dari VPS/PC rumah', true)
    }
    if (!CHALLENGE.test(st)) return
    await sleep(1000)
  }
  throw new SolverError('solver Cloudflare: tantangan tidak selesai dalam batas waktu')
}

// ---------------------------------------------------------------- API
/** Lewati tantangan untuk `origin` (mis. https://komiku.org) dan simpan sesinya. Satu proses solver pada satu waktu. */
export function solve(origin: string, force = false): Promise<CfSession> {
  const host = new URL(origin).hostname
  const cur = sessions.get(host)
  if (!force && cur && Date.now() - cur.at < TTL_MS) return Promise.resolve(cur)
  if (inflight) return inflight
  if (Date.now() - failedAt < COOLDOWN_MS) {
    return Promise.reject(new SolverError('solver Cloudflare sedang jeda setelah gagal; coba lagi sebentar'))
  }
  const p = serial(async () => {
    try {
      const { page } = await openBrowser()
      touch()
      await page.goto(origin.replace(/\/+$/, '') + '/', { waitUntil: 'domcontentloaded', timeout: TIMEOUT_MS })
      await waitClear(page, TIMEOUT_MS)
      const cookies: Array<{ name: string; value: string }> = await page.cookies()
      const ua: string = await page.evaluate(() => navigator.userAgent)
      const s: CfSession = {
        host,
        ua,
        cookie: cookies.map(c => `${c.name}=${c.value}`).join('; '),
        at: Date.now(),
        hasClearance: cookies.some(c => c.name === 'cf_clearance')
      }
      sessions.set(host, s)
      failedAt = 0
      return s
    } catch (e) {
      failedAt = Date.now()
      await closeBrowser()
      throw e instanceof SolverError ? e : new SolverError(`solver Cloudflare gagal: ${(e as Error)?.message || 'error'}`)
    } finally {
      inflight = null
    }
  })
  inflight = p
  return p
}

/** Ambil `url` lewat Chrome yang sudah lolos tantangan (cadangan bila fetch+cookie tetap ditolak). */
export function browserGet(url: string): Promise<string> {
  return serial(async () => {
    try {
      const { page } = await openBrowser()
      touch()
      const read = async () => {
        const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: TIMEOUT_MS })
        const status: number = resp?.status() ?? 0
        const body: string = resp ? await resp.text().catch(() => '') : await page.content()
        return { status, body }
      }
      let { status, body } = await read()
      if (status === 404 || status === 410) throw new NotFoundError('Not found upstream')
      if (status === 403 || status === 503 || CHALLENGE.test(body.slice(0, 4000))) {
        await waitClear(page, TIMEOUT_MS)
        ;({ status, body } = await read()) // muat ulang dengan cookie yang baru didapat (JSON tetap mentah)
        if (status === 404 || status === 410) throw new NotFoundError('Not found upstream')
      }
      if (status < 200 || status >= 300) throw new SolverError(`HTTP ${status} (lewat browser)`)
      if (CHALLENGE.test(body.slice(0, 4000)) && body.length < 15000) throw new SolverError('halaman tantangan Cloudflare masih tampil (lewat browser)')
      return body
    } catch (e) {
      if (e instanceof NotFoundError || e instanceof SolverError) throw e
      throw new SolverError(`browser gagal mengambil halaman: ${(e as Error)?.message || 'error'}`)
    }
  })
}
