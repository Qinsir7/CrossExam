import type { DecisionPackage, Finding, Reviewer } from '../domain/types'

export const demoDecision: DecisionPackage = {
  id: 'DP-042',
  title: 'Execute position',
  valueAtRiskUsd: 12500,
  claims: [
    {
      id: 'C-01',
      statement: 'Liquidity is deep enough to execute the proposed position with less than 1% price impact.',
      materiality: 0.92,
    },
    {
      id: 'C-02',
      statement: 'No privileged mint or blacklist path can change the asset’s supply or transferability.',
      materiality: 0.84,
    },
    {
      id: 'C-03',
      statement: 'The catalyst is scheduled for this week and is already reflected in current market attention.',
      materiality: 0.73,
    },
    {
      id: 'C-04',
      statement: 'The recommendation remains positive after accounting for holder concentration risk.',
      materiality: 0.88,
    },
  ],
}

export const demoReviewers: Reviewer[] = [
  {
    id: 'liquidity-scout',
    name: 'Liquidity Scout',
    ownerId: 'independent-onchain-labs',
    modelFamily: 'deterministic-onchain',
    evidenceRoute: 'dex-liquidity-reconstruction',
  },
  {
    id: 'contract-examiner',
    name: 'Contract Examiner',
    ownerId: 'audit-guild',
    modelFamily: 'symbolic-static-analysis',
    evidenceRoute: 'verified-source-and-bytecode',
  },
  {
    id: 'evidence-desk',
    name: 'Evidence Desk',
    ownerId: 'research-collective',
    modelFamily: 'retrieval-and-source-checking',
    evidenceRoute: 'primary-source-validation',
  },
]

export const demoFindings: Finding[] = [
  {
    claimId: 'C-01',
    reviewerId: 'liquidity-scout',
    verdict: 'CONTRADICTS',
    confidence: 0.92,
    materiality: 0.92,
    evidence: 'The cited liquidity snapshot omits the locked side of the pool. Live usable depth is 41% below the recommendation threshold.',
  },
  {
    claimId: 'C-02',
    reviewerId: 'contract-examiner',
    verdict: 'SUPPORTS',
    confidence: 0.89,
    materiality: 0.84,
    evidence: 'Source contract and proxy implementation were both inspected. No executable mint or blacklist path was found.',
  },
  {
    claimId: 'C-03',
    reviewerId: 'evidence-desk',
    verdict: 'INSUFFICIENT_EVIDENCE',
    confidence: 0.81,
    materiality: 0.73,
    evidence: 'Two independent sources disagree on the launch date. The primary announcement links to a removed post.',
  },
  {
    claimId: 'C-04',
    reviewerId: 'liquidity-scout',
    verdict: 'CONTRADICTS',
    confidence: 0.94,
    materiality: 0.88,
    evidence: 'Three linked wallets control 27.8% of circulating supply and can exit without a vesting constraint.',
  },
]
