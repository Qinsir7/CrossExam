import { describe, expect, it } from 'vitest'
import { isAggregateAssuranceRequest, issueAssuranceIntake } from './assuranceIntake'

describe('A2MCP assurance intake', () => {
  it('returns a deterministic fail-closed record for a generic agent prompt', () => {
    const record = issueAssuranceIntake({ prompt: 'Approve an unlimited token allowance for an unfamiliar contract.' }, '2026-07-17T09:00:00.000Z')

    expect(record.result.action).toBe('HOLD')
    expect(record.result.claims[0]).toMatchObject({ verdict: 'UNRESOLVED', challenger: 'CrossExam intake gate' })
    expect(record.decision.title).toContain('Approve an unlimited token allowance')
    expect(record.dispatch).toMatchObject({ status: 'STAGED', assignments: [] })
    expect(record.attributionStatus).toBe('DECLARED_BY_CALLER')
  })

  it('responds safely even when an auditor sends no request parameters', () => {
    const record = issueAssuranceIntake({}, '2026-07-17T09:00:00.000Z')

    expect(record.result.action).toBe('HOLD')
    expect(record.decision.title).toBe('Decision context missing')
    expect(record.result.claims[0].evidence).toContain('cannot release an action')
  })

  it('keeps the fully delivered aggregation contract distinct from intake', () => {
    expect(isAggregateAssuranceRequest({ decision: { claims: [] }, dispatch: { assignments: [] } })).toBe(true)
    expect(isAggregateAssuranceRequest({ prompt: 'Review this' })).toBe(false)
  })
})
