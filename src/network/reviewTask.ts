import type { DecisionPackage } from '../domain/types'
import type { ReviewPlan, ReviewScope } from '../domain/reviewPlan'

export type BlindReviewTask = {
  schemaVersion: '0.1'
  taskId: string
  decisionId: string
  scope: Pick<ReviewScope, 'id' | 'title' | 'objective' | 'requiredCapability'>
  claims: DecisionPackage['claims']
  instructions: string[]
  deliveryRequirements: {
    addressEveryClaim: true
    requireTraceableArtifact: true
    acceptedVerdicts: ['SUPPORTS', 'CONTRADICTS', 'INSUFFICIENT_EVIDENCE']
  }
  withheldContext: ['origin_recommendation', 'other_reviewer_findings', 'aggregate_verdict']
}

/**
 * Produces the first-round challenger payload. It intentionally excludes the
 * source agent's recommendation and every other review result, preventing
 * reviewers from anchoring on the conclusion they are meant to challenge.
 */
export function createBlindReviewTask(decision: DecisionPackage, plan: ReviewPlan, scopeId: string): BlindReviewTask {
  const scope = plan.scopes.find((candidate) => candidate.id === scopeId)
  if (!scope) throw new Error('Review scope does not belong to this review plan.')
  const claims = decision.claims.filter((claim) => scope.claimIds.includes(claim.id))
  if (claims.length !== scope.claimIds.length) throw new Error('Review scope references claims outside this Decision Package.')

  return {
    schemaVersion: '0.1',
    taskId: `RT-${plan.id.replace('RP-', '')}-${scope.id}`,
    decisionId: decision.id,
    scope: {
      id: scope.id,
      title: scope.title,
      objective: scope.objective,
      requiredCapability: scope.requiredCapability,
    },
    claims,
    instructions: [
      'Independently investigate each claim before forming a conclusion.',
      'Report contradiction when evidence materially challenges a claim; do not optimize for agreement.',
      'Return INSUFFICIENT_EVIDENCE when the available evidence cannot justify a conclusion.',
    ],
    deliveryRequirements: {
      addressEveryClaim: true,
      requireTraceableArtifact: true,
      acceptedVerdicts: ['SUPPORTS', 'CONTRADICTS', 'INSUFFICIENT_EVIDENCE'],
    },
    withheldContext: ['origin_recommendation', 'other_reviewer_findings', 'aggregate_verdict'],
  }
}
