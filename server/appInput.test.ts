import { describe, expect, it } from 'vitest'
import type express from 'express'
import { paidReviewInput } from './app'

function request(body: unknown, headers: Record<string, string> = {}, query: Record<string, string> = {}) {
  return { body, query, header: (name: string) => headers[name.toLowerCase()] } as unknown as express.Request
}

describe('A2MCP paid-review input normalization', () => {
  it('accepts nested params and a platform request identifier', () => {
    expect(paidReviewInput(request({ params: { prompt: 'Challenge this contract.', profile: 'LEGAL', requestId: 'request-0000000000000000000000001' } }))).toMatchObject({
      text: 'Challenge this contract.', profile: 'LEGAL', idempotencyKey: 'request-0000000000000000000000001',
    })
  })

  it('accepts an object input envelope used by generic agent clients', () => {
    expect(paidReviewInput(request({ input: { text: 'Attack this plan.', profile: 'PLAN' }, taskId: 'task-0000000000000000000000000001' }))).toMatchObject({
      text: 'Attack this plan.', profile: 'PLAN', idempotencyKey: 'task-0000000000000000000000000001',
    })
  })

  it('prefers the standard idempotency header', () => {
    expect(paidReviewInput(request({ query: 'Review this.' }, { 'idempotency-key': 'header-00000000000000000000000001' })).idempotencyKey).toBe('header-00000000000000000000000001')
  })
})
