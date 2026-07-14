import { runCrossExam } from './crossExam'
import type { CrossExamResult, DecisionPackage, Reviewer } from './types'
import type { ReviewDispatch } from '../network/reviewNetwork'

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

  return runCrossExam(decision, reviewers, findings)
}
