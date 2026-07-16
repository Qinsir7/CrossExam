import { describe, expect, it } from 'vitest'
import { loadX402ServerConfig } from './config'

const validEnvironment = {
  CROSSEXAM_PAY_TO: '0x1111111111111111111111111111111111111111',
  OKX_API_KEY: 'api-key',
  OKX_SECRET_KEY: 'secret',
  OKX_PASSPHRASE: 'passphrase',
  CROSSEXAM_SERVICE_SIGNING_KEY: '0x0123456789012345678901234567890123456789012345678901234567890123',
}

describe('loadX402ServerConfig', () => {
  it('loads a seller-only X Layer x402 configuration', () => {
    const config = loadX402ServerConfig(validEnvironment)

    expect(config.port).toBe(4022)
    expect(config.priceUsd).toBe('0.02')
    expect(config.payTo).toBe(validEnvironment.CROSSEXAM_PAY_TO)
    expect(config.syncFacilitatorOnStart).toBe(true)
  })

  it('uses the hosting platform PORT and parses an explicit browser-origin allowlist', () => {
    const config = loadX402ServerConfig({
      ...validEnvironment,
      PORT: '8080',
      CROSSEXAM_ALLOWED_ORIGINS: 'https://cross-exam.xyz,https://www.cross-exam.xyz',
    })
    expect(config.port).toBe(8080)
    expect(config.allowedOrigins).toEqual(['https://cross-exam.xyz', 'https://www.cross-exam.xyz'])
  })

  it('rejects a CORS allowlist entry with a path instead of an origin', () => {
    expect(() => loadX402ServerConfig({ ...validEnvironment, CROSSEXAM_ALLOWED_ORIGINS: 'https://cross-exam.xyz/path' })).toThrow('origins')
  })

  it('rejects a placeholder or malformed recipient address', () => {
    expect(() => loadX402ServerConfig({ ...validEnvironment, CROSSEXAM_PAY_TO: '0xSeller' })).toThrow('20-byte')
  })

  it('rejects a price outside the deliberately narrow early-stage limit', () => {
    expect(() => loadX402ServerConfig({ ...validEnvironment, CROSSEXAM_X402_PRICE_USD: '11' })).toThrow('no greater than 10')
  })

  it('allows the facilitator sync only to be explicitly disabled for local non-payment smoke tests', () => {
    expect(loadX402ServerConfig({ ...validEnvironment, CROSSEXAM_X402_SYNC: 'false' }).syncFacilitatorOnStart).toBe(false)
  })

  it('does not permit a paid seller to issue unsigned assurance records', () => {
    const { CROSSEXAM_SERVICE_SIGNING_KEY: _signingKey, ...unsigned } = validEnvironment
    expect(() => loadX402ServerConfig(unsigned)).toThrow('SERVICE_SIGNING_KEY')
    expect(loadX402ServerConfig({ ...unsigned, CROSSEXAM_X402_SYNC: 'false' }).serviceSigningKey).toBeUndefined()
  })

  it('parses server-owned reviewer identity and wallet bindings without exposing them to the browser', () => {
    const config = loadX402ServerConfig({
      ...validEnvironment,
      CROSSEXAM_REVIEWER_REGISTRY: '[{"id":"reviewer-1","displayName":"Source verifier","ownerId":"independent-lab","modelFamily":"retrieval","evidenceRoutes":["primary"],"capabilities":["source verification"],"wallet":"0x2222222222222222222222222222222222222222"}]',
    })

    expect(config.reviewerRegistry['reviewer-1'].wallet).toBe('0x2222222222222222222222222222222222222222')
    expect(config.reviewerRegistry['reviewer-1'].ownerId).toBe('independent-lab')
  })

  it('requires the explicit signed-callback protocol before a reviewer can receive paid work', () => {
    const withoutProtocol = '[{"id":"reviewer-1","displayName":"Source verifier","ownerId":"independent-lab","modelFamily":"retrieval","evidenceRoutes":["primary"],"capabilities":["source verification"],"wallet":"0x2222222222222222222222222222222222222222","procurementEndpoint":"https://reviewer.example/reviews"}]'
    expect(() => loadX402ServerConfig({ ...validEnvironment, CROSSEXAM_REVIEWER_REGISTRY: withoutProtocol })).toThrow('invalid or duplicate')
    const withProtocol = withoutProtocol.replace('"procurementEndpoint":"https://reviewer.example/reviews"', '"procurementEndpoint":"https://reviewer.example/reviews","procurementProtocol":"CROSSEXAM_SIGNED_CALLBACK_V1"')
    expect(loadX402ServerConfig({ ...validEnvironment, CROSSEXAM_REVIEWER_REGISTRY: withProtocol }).reviewerRegistry['reviewer-1'].procurementProtocol).toBe('CROSSEXAM_SIGNED_CALLBACK_V1')
  })

  it('rejects duplicate reviewer wallet bindings in the server-owned registry', () => {
    const registry = '[{"id":"reviewer-1","displayName":"One","ownerId":"owner-1","modelFamily":"model-1","evidenceRoutes":["a"],"capabilities":["source verification"],"wallet":"0x2222222222222222222222222222222222222222"},{"id":"reviewer-2","displayName":"Two","ownerId":"owner-2","modelFamily":"model-2","evidenceRoutes":["b"],"capabilities":["adversarial research"],"wallet":"0x2222222222222222222222222222222222222222"}]'
    expect(() => loadX402ServerConfig({ ...validEnvironment, CROSSEXAM_REVIEWER_REGISTRY: registry })).toThrow('duplicate')
  })

  it('requires an explicit asset allowlist and atomic cap before enabling a buyer-side procurement signer', () => {
    const signer = '0x1123456789012345678901234567890123456789012345678901234567890123'
    expect(() => loadX402ServerConfig({ ...validEnvironment, CROSSEXAM_PROCUREMENT_SIGNING_KEY: signer })).toThrow('MAX_PER_SCOPE_ATOMIC')
    const config = loadX402ServerConfig({
      ...validEnvironment,
      CROSSEXAM_PROCUREMENT_SIGNING_KEY: signer,
      CROSSEXAM_PROCUREMENT_MAX_PER_SCOPE_ATOMIC: '250000',
      CROSSEXAM_PROCUREMENT_ALLOWED_ASSETS: '0x5555555555555555555555555555555555555555',
    })
    expect(config.procurementMaxPerScopeAtomic).toBe(250000n)
    expect(config.procurementAllowedAssets).toEqual(['0x5555555555555555555555555555555555555555'])
  })

  it('parses outcome-authority wallet bindings separately from reviewer identities', () => {
    const config = loadX402ServerConfig({
      ...validEnvironment,
      CROSSEXAM_OUTCOME_AUTHORITY_WALLETS: '{"xlayer-finality":"0x3333333333333333333333333333333333333333"}',
    })

    expect(config.outcomeAuthorityWallets['xlayer-finality']).toBe('0x3333333333333333333333333333333333333333')
  })

  it('parses executor wallet bindings separately from outcome authorities', () => {
    const config = loadX402ServerConfig({
      ...validEnvironment,
      CROSSEXAM_EXECUTOR_WALLETS: '{"trade-executor":"0x4444444444444444444444444444444444444444"}',
    })

    expect(config.executorWallets['trade-executor']).toBe('0x4444444444444444444444444444444444444444')
  })

  it('uses a local durable data directory unless a deployment overrides it', () => {
    expect(loadX402ServerConfig(validEnvironment).dataDirectory).toBe('.crossexam-data')
    expect(loadX402ServerConfig({ ...validEnvironment, CROSSEXAM_DATA_DIR: '/data/crossexam' }).dataDirectory).toBe('/data/crossexam')
  })

  it('accepts only PostgreSQL URLs for the shared production store', () => {
    expect(loadX402ServerConfig({ ...validEnvironment, CROSSEXAM_DATABASE_URL: 'postgresql://cross:secret@db.example/crossexam' }).databaseUrl).toContain('postgresql://')
    expect(() => loadX402ServerConfig({ ...validEnvironment, CROSSEXAM_DATABASE_URL: 'https://db.example/crossexam' })).toThrow('postgres')
  })
})
