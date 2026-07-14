import { runCrossExam } from '../domain/crossExam'
import type { DecisionPackage, Finding, Reviewer } from '../domain/types'
import { evaluateDecisionResult, summarizeBenchmark, type TruthLabeledDecision } from './benchmark'

export type DemoTruthCase = {
  name: string
  decision: DecisionPackage
  reviewers: Reviewer[]
  findings: Finding[]
  truth: TruthLabeledDecision
}

const reviewers: Reviewer[] = [
  { id: 'source', name: 'Source Examiner', ownerId: 'owner-source', modelFamily: 'model-source', evidenceRoute: 'primary-source' },
  { id: 'challenge', name: 'Counterexample Lab', ownerId: 'owner-challenge', modelFamily: 'model-challenge', evidenceRoute: 'counterexample-search' },
  { id: 'domain', name: 'Domain Risk Lab', ownerId: 'owner-domain', modelFamily: 'model-domain', evidenceRoute: 'domain-tooling' },
]

export const demoTruthCases: DemoTruthCase[] = [
  {
    name: 'material contradiction blocks action',
    decision: { id: 'DP-EVAL-1', title: 'Execute high-risk action', valueAtRiskUsd: 10_000, claims: [{ id: 'C-1', statement: 'The critical risk control is active.', materiality: 0.9 }] },
    reviewers,
    findings: [
      { claimId: 'C-1', reviewerId: 'source', verdict: 'SUPPORTS', confidence: 0.9, materiality: 0.9, evidence: 'An outdated document claims the control is active.' },
      { claimId: 'C-1', reviewerId: 'challenge', verdict: 'CONTRADICTS', confidence: 0.91, materiality: 0.95, evidence: 'A current primary record shows the control is disabled.' },
    ],
    truth: { id: 'DP-EVAL-1', claims: [{ id: 'C-1', expectedVerdict: 'REFUTED', materiality: 0.9 }] },
  },
  {
    name: 'honest uncertainty remains conditional',
    decision: { id: 'DP-EVAL-2', title: 'Approve an uncertain action', valueAtRiskUsd: 2_000, claims: [{ id: 'C-2', statement: 'A required approval exists.', materiality: 0.8 }] },
    reviewers,
    findings: [{ claimId: 'C-2', reviewerId: 'source', verdict: 'INSUFFICIENT_EVIDENCE', confidence: 0.8, materiality: 0.8, evidence: 'No primary approval record was available.' }],
    truth: { id: 'DP-EVAL-2', claims: [{ id: 'C-2', expectedVerdict: 'UNRESOLVED', materiality: 0.8 }] },
  },
  {
    name: 'supported action proceeds',
    decision: { id: 'DP-EVAL-3', title: 'Execute a bounded action', valueAtRiskUsd: 500, claims: [{ id: 'C-3', statement: 'The required control is active.', materiality: 0.8 }] },
    reviewers,
    findings: [{ claimId: 'C-3', reviewerId: 'domain', verdict: 'SUPPORTS', confidence: 0.92, materiality: 0.8, evidence: 'A current primary record confirms the control.' }],
    truth: { id: 'DP-EVAL-3', claims: [{ id: 'C-3', expectedVerdict: 'SURVIVED', materiality: 0.8 }] },
  },
]

/** Synthetic regression cases only. They are not a claim of real-world lift. */
export function runDemoBenchmark() {
  return summarizeBenchmark(demoTruthCases.map((testCase) => evaluateDecisionResult(
    testCase.truth,
    runCrossExam(testCase.decision, testCase.reviewers, testCase.findings),
  )))
}
