import { describe, expect, it, vi } from 'vitest'
import { fixedWindowRateLimit } from './rateLimit'

describe('fixedWindowRateLimit', () => {
  it('fails closed after the configured free-write budget and resets later', () => {
    let now = 1_000
    const middleware = fixedWindowRateLimit({ limit: 2, windowMs: 1_000, now: () => now })
    const request = { ip: '203.0.113.7', socket: {} } as never
    const status = vi.fn().mockReturnThis()
    const json = vi.fn()
    const response = { setHeader: vi.fn(), status, json } as never
    const next = vi.fn()
    middleware(request, response, next)
    middleware(request, response, next)
    middleware(request, response, next)
    expect(next).toHaveBeenCalledTimes(2)
    expect(status).toHaveBeenCalledWith(429)
    now = 2_001
    middleware(request, response, next)
    expect(next).toHaveBeenCalledTimes(3)
  })
})
