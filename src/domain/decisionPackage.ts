import type { ActionBinding, DecisionPackage, ReviewProfile } from './types'

export type DecisionPackageInput = {
  title: string
  valueAtRiskUsd: number
  claimsText: string
  actionBinding?: ActionBinding
  reviewProfile?: ReviewProfile
}

export type DecisionPackageValidation =
  | { ok: true; value: DecisionPackage }
  | { ok: false; errors: string[] }

function localId() {
  return `DP-${crypto.randomUUID().slice(0, 8).toUpperCase()}`
}

/**
 * Normalizes a human or agent supplied decision into the minimum contract that
 * can be sent to independent reviewers. It deliberately does not infer facts
 * or invent claims: every line remains attributable to the submitter.
 */
export function createDecisionPackage(input: DecisionPackageInput): DecisionPackageValidation {
  const title = input.title.trim()
  const claims = input.claimsText
    .split('\n')
    .map((claim) => claim.trim())
    .filter(Boolean)

  const errors: string[] = []
  if (!title) errors.push('Describe the action the agent intends to take.')
  if (!Number.isFinite(input.valueAtRiskUsd) || input.valueAtRiskUsd <= 0) {
    errors.push('Provide a value at risk greater than zero.')
  }
  if (claims.length === 0) errors.push('Provide at least one claim the decision depends on.')
  if (claims.length > 12) errors.push('Limit this first review to 12 material claims.')

  if (errors.length > 0) return { ok: false, errors }

  return {
    ok: true,
    value: {
      id: localId(),
      title,
      valueAtRiskUsd: input.valueAtRiskUsd,
      ...(input.actionBinding ? { actionBinding: input.actionBinding } : {}),
      ...(input.reviewProfile ? { reviewProfile: input.reviewProfile } : {}),
      claims: claims.map((statement, index) => ({
        id: `C-${String(index + 1).padStart(2, '0')}`,
        statement,
        materiality: 0.5,
      })),
    },
  }
}
