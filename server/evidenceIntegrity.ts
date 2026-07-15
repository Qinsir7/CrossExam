import { keccak256, stringToHex, type Hex } from 'viem'
import type { Finding } from '../src/domain/types'
import type { EvidenceArtifact, ReviewDispatch } from '../src/network/reviewNetwork'

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`).join(',')}}`
}

/** Hashes only the observation fields, so a delivery signature can bind it without recursion. */
export function evidenceArtifactHash(artifact: Omit<EvidenceArtifact, 'contentHash'>): Hex {
  return keccak256(stringToHex(canonicalize(artifact)))
}

function assertFindingEvidence(finding: Finding, artifactIds: Set<string>) {
  if (!finding.evidenceArtifactIds?.length) {
    throw new Error('Every network-delivered finding must cite at least one evidence artifact.')
  }
  if (new Set(finding.evidenceArtifactIds).size !== finding.evidenceArtifactIds.length
    || finding.evidenceArtifactIds.some((artifactId) => !artifactIds.has(artifactId))) {
    throw new Error('A finding cites an unknown or duplicate evidence artifact.')
  }
}

/**
 * Checks the evidence graph before aggregation. A signed delivery proves who
 * submitted the graph; these checks prove every claim points to a concrete,
 * immutable evidence object carried by that exact delivery.
 */
export function assertDispatchEvidenceIntegrity(dispatch: ReviewDispatch): void {
  for (const assignment of dispatch.assignments) {
    const delivery = assignment.delivery
    if (!delivery) throw new Error('A decision-grade dispatch requires every assignment to be delivered.')

    const artifactIds = new Set<string>()
    for (const artifact of delivery.artifacts) {
      if (!artifact.id.trim() || artifactIds.has(artifact.id)) {
        throw new Error('Evidence artifact identifiers must be unique within a delivery.')
      }
      artifactIds.add(artifact.id)
      if (!artifact.contentHash || artifact.contentHash !== evidenceArtifactHash({
        id: artifact.id,
        kind: artifact.kind,
        locator: artifact.locator,
        observedAt: artifact.observedAt,
        excerpt: artifact.excerpt,
      })) {
        throw new Error('Evidence artifact content hash does not match the submitted artifact.')
      }
    }
    if (!artifactIds.size) throw new Error('A decision-grade delivery requires evidence artifacts.')
    delivery.findings.forEach((finding) => assertFindingEvidence(finding, artifactIds))
  }
}
