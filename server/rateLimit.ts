import type { RequestHandler } from 'express'

type Window = { count: number; resetAt: number }

/**
 * Small per-replica abuse boundary for free write endpoints. Paid x402 routes
 * have their own economic limit; this protects quote/job creation without
 * turning the browser flow into a CAPTCHA. A managed edge limiter can replace
 * this interface without changing route semantics.
 */
export function fixedWindowRateLimit(options: { limit: number; windowMs: number; now?: () => number }): RequestHandler {
  if (!Number.isInteger(options.limit) || options.limit < 1 || !Number.isInteger(options.windowMs) || options.windowMs < 1_000) {
    throw new Error('Rate-limit policy requires a positive limit and a window of at least one second.')
  }
  const windows = new Map<string, Window>()
  const now = options.now ?? Date.now
  return (request, response, next) => {
    const timestamp = now()
    const key = request.ip || request.socket.remoteAddress || 'unknown'
    const current = windows.get(key)
    const window = !current || current.resetAt <= timestamp
      ? { count: 1, resetAt: timestamp + options.windowMs }
      : { ...current, count: current.count + 1 }
    windows.set(key, window)
    response.setHeader('RateLimit-Limit', String(options.limit))
    response.setHeader('RateLimit-Remaining', String(Math.max(0, options.limit - window.count)))
    response.setHeader('RateLimit-Reset', String(Math.ceil(window.resetAt / 1_000)))
    if (window.count > options.limit) {
      response.setHeader('Retry-After', String(Math.max(1, Math.ceil((window.resetAt - timestamp) / 1_000))))
      response.status(429).json({ error: 'RATE_LIMITED', message: 'Too many free write requests; retry after the current rate-limit window.' })
      return
    }
    if (windows.size > 10_000) {
      for (const [candidate, entry] of windows) if (entry.resetAt <= timestamp) windows.delete(candidate)
    }
    next()
  }
}
