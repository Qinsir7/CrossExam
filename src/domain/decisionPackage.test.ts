import { describe, expect, it } from 'vitest'
import { createDecisionPackage } from './decisionPackage'

describe('createDecisionPackage', () => {
  it('turns distinct submitted lines into attributable review claims', () => {
    const result = createDecisionPackage({
      title: 'Approve the vendor',
      valueAtRiskUsd: 5000,
      claimsText: 'The vendor has SOC 2 coverage.\n\nThe data residency matches our policy.',
    })

    expect(result.ok).toBe(true)
    if (result.ok === false) return
    expect(result.value.claims).toEqual([
      { id: 'C-01', statement: 'The vendor has SOC 2 coverage.', materiality: 0.5 },
      { id: 'C-02', statement: 'The data residency matches our policy.', materiality: 0.5 },
    ])
  })

  it('refuses a package with no action, value, or claims', () => {
    const result = createDecisionPackage({ title: ' ', valueAtRiskUsd: 0, claimsText: ' ' })

    expect(result.ok).toBe(false)
    if (result.ok === true) return
    expect(result.errors).toHaveLength(3)
  })
})
