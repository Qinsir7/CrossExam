import { describe, expect, it } from 'vitest'
import { createServiceManifest } from './serviceManifest'

describe('createServiceManifest', () => {
  it('publishes every capability on the configured stable external API base', () => {
    const manifest = createServiceManifest('https://www.cross-exam.xyz/review-service/')

    expect(manifest.discovery.homepage).toBe('https://www.cross-exam.xyz/review-service/')
    expect(manifest.capabilities).not.toHaveLength(0)
    expect(manifest.capabilities.every(({ endpoint }) => endpoint.startsWith('https://www.cross-exam.xyz/review-service/api/'))).toBe(true)
    expect(manifest.capabilities.find(({ id }) => id === 'decision-assurance.aggregate')?.endpoint)
      .toBe('https://www.cross-exam.xyz/review-service/api/v1/assurance/aggregate')
  })
})
