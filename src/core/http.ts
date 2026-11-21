import { NotFoundError, UpstreamError } from './errors.js'
import { sleep } from './util.js'

export interface RequestOptions {
  headers: Record<string, string>
  timeoutMs: number
  /** Opsional: batalkan request dari luar (mis. saat mirror lain sudah menang). */
  signal?: AbortSignal
}

/** fetch + timeout; 404 -> NotFoundError, non-2xx -> UpstreamError. */
export async function request(url: string, { headers, timeoutMs, signal }: RequestOptions): Promise<Response> {
  const timeout = AbortSignal.timeout(timeoutMs)
  const res = await fetch(url, { headers, signal: signal ? AbortSignal.any([timeout, signal]) : timeout })
  if (res.status === 404) {
    await res.body?.cancel()
    throw new NotFoundError('Not found upstream')
  }
  if (!res.ok) {
    await res.body?.cancel()
    const hint = [res.headers.get('cf-mitigated') && `cf-mitigated: ${res.headers.get('cf-mitigated')}`, res.headers.get('server') && `server: ${res.headers.get('server')}`].filter(Boolean).join(', ')
    throw new UpstreamError(`HTTP ${res.status}${hint ? ` [${hint}]` : ''}`, res.status)
  }
  return res
}

/** Retry ringan (default 2x ulang, jeda 400ms); 404 tidak diulang. */
export async function retry<T>(fn: () => Promise<T>, retries = 2, delayMs = 400): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await fn()
    } catch (e) {
      if (i >= retries || e instanceof NotFoundError) throw e
      await sleep(delayMs)
    }
  }
}
