import { describe, expect, it } from 'vitest'
import { loadX402ServerConfig } from './config'

const validEnvironment = {
  CROSSEXAM_PAY_TO: '0x1111111111111111111111111111111111111111',
  OKX_API_KEY: 'api-key',
  OKX_SECRET_KEY: 'secret',
  OKX_PASSPHRASE: 'passphrase',
}

describe('loadX402ServerConfig', () => {
  it('loads a seller-only X Layer x402 configuration', () => {
    const config = loadX402ServerConfig(validEnvironment)

    expect(config.port).toBe(4022)
    expect(config.priceUsd).toBe('0.02')
    expect(config.payTo).toBe(validEnvironment.CROSSEXAM_PAY_TO)
    expect(config.syncFacilitatorOnStart).toBe(true)
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

  it('parses registered reviewer wallet bindings without exposing them to the browser', () => {
    const config = loadX402ServerConfig({
      ...validEnvironment,
      CROSSEXAM_REVIEWER_WALLETS: '{"reviewer-1":"0x2222222222222222222222222222222222222222"}',
    })

    expect(config.reviewerWallets['reviewer-1']).toBe('0x2222222222222222222222222222222222222222')
  })

  it('uses a local durable data directory unless a deployment overrides it', () => {
    expect(loadX402ServerConfig(validEnvironment).dataDirectory).toBe('.crossexam-data')
    expect(loadX402ServerConfig({ ...validEnvironment, CROSSEXAM_DATA_DIR: '/data/crossexam' }).dataDirectory).toBe('/data/crossexam')
  })
})
