import { runCrossExam, type DeterministicFinding } from './crossExam'
import type { CrossExamResult, DecisionPackage, Finding, Reviewer } from './types'
import type { ReviewDispatch } from '../network/reviewNetwork'

const ACTION_BINDING_CLAIM_ID = 'C-ACTION-BINDING'
const ACTION_BINDING_REVIEWER_ID = 'crossexam-canonical-action-binding'

/**
 * The reviewed binding is created and later re-derived by CrossExam itself;
 * it is neither an external-provider observation nor an independent reviewer
 * opinion. Keeping it separate prevents a liquidity/security source from
 * incorrectly making the binding claim unresolved.
 */
function deterministicActionBindingFindings(decision: DecisionPackage): DeterministicFinding[] {
  if (decision.reviewProfile !== 'PRETRADE_ONCHAIN' || !decision.actionBinding) return []
  const bindingClaim = decision.claims.find((claim) => claim.id === ACTION_BINDING_CLAIM_ID)
  if (!bindingClaim) return []
  const finding: Finding = {
    claimId: bindingClaim.id,
    reviewerId: ACTION_BINDING_REVIEWER_ID,
    verdict: 'SUPPORTS',
    confidence: 1,
    materiality: bindingClaim.materiality,
    evidence: 'CrossExam canonically bound the reviewed action parameters. The execution gate will re-derive this binding before any transaction is released.',
  }
  return [{ finding, sourceLabel: 'CrossExam canonical action binding' }]
}

/**
 * The single gateway from procured evidence into a decision recommendation.
 * It refuses partial reviews. This means a system outage or an uncooperative
 * reviewer produces an explicit incomplete state upstream, rather than a
 * deceptively clean action recommendation.
 */
export function completeCrossExam(decision: DecisionPackage, dispatch: ReviewDispatch): CrossExamResult {
  if (dispatch.decisionId !== decision.id) {
    throw new Error('This review dispatch belongs to a different decision package.')
  }
  if (dispatch.status !== 'DELIVERED' || dispatch.assignments.some((assignment) => assignment.status !== 'DELIVERED' || !assignment.reviewer || !assignment.delivery)) {
    throw new Error('A CrossExam result requires delivered evidence from every independent scope.')
  }

  const reviewers: Reviewer[] = dispatch.assignments.map((assignment) => ({
    id: assignment.reviewer!.id,
    name: assignment.reviewer!.displayName,
    ownerId: assignment.reviewer!.ownerId,
    modelFamily: assignment.reviewer!.modelFamily,
    evidenceRoute: assignment.reviewer!.evidenceRoutes.join('|'),
  }))
  const findings = dispatch.assignments.flatMap((assignment) => assignment.delivery!.findings)

  return runCrossExam(decision, reviewers, findings, deterministicActionBindingFindings(decision))
}
