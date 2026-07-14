import { describe, expect, it } from 'vitest'
import { runDemoBenchmark } from './demoTruthCases'

describe('demo truth benchmark', () => {
  it('protects critical contradictions and preserves uncertainty in the synthetic regression set', () => {
    expect(runDemoBenchmark()).toEqual({
      decisions: 3,
      materialContradictionRecall: 1,
      unsafeActionRate: 0,
      overblockingRate: 0,
      reversalCoverage: 1,
    })
  })
})
