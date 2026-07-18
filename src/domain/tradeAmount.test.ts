import { describe, expect, it } from 'vitest'
import { usdt0Atomic } from './tradeAmount'

describe('usdt0Atomic', () => {
  it('converts whole and fractional USDT0 without floating-point math', () => {
    expect(usdt0Atomic('500')).toBe('500000000')
    expect(usdt0Atomic('0.000001')).toBe('1')
    expect(usdt0Atomic('12.3456')).toBe('12345600')
  })

  it('rejects zero, excessive precision, negative, and oversized input', () => {
    expect(() => usdt0Atomic('0')).toThrow('greater than 0')
    expect(() => usdt0Atomic('1.0000001')).toThrow('no more than 6')
    expect(() => usdt0Atomic('-1')).toThrow('no more than 6')
    expect(() => usdt0Atomic('1000000000')).toThrow('no more than 6')
  })
})
