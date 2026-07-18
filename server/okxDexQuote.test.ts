import { describe, expect, it } from 'vitest'
import { requestOkxDexQuote, validateOkxDexQuoteRequest } from './okxDexQuote'

const input = {
  fromTokenAddress: '0x779ded0c9e1022225f8e0630b35a9b54be713736',
  toTokenAddress: '0x095c1a875b985be6e2c86b2cae0b66a3df702e6a',
  amount: '10000000000',
  slippagePercent: '0.5',
  userWalletAddress: '0x1111111111111111111111111111111111111111',
}

describe('OKX DEX quote adapter', () => {
  it('accepts only conservative X Layer route inputs', () => {
    expect(validateOkxDexQuoteRequest(input)).toMatchObject({ fromTokenAddress: input.fromTokenAddress, toTokenAddress: input.toTokenAddress })
    expect(() => validateOkxDexQuoteRequest({ ...input, slippagePercent: '5.1' })).toThrow('no more than 5%')
    expect(() => validateOkxDexQuoteRequest({ ...input, fromTokenAddress: input.toTokenAddress })).toThrow('must differ')
  })

  it('normalizes an exact non-broadcast router transaction without returning provider credentials', async () => {
    const quote = await requestOkxDexQuote(input, { apiKey: 'key', secretKey: 'secret', passphrase: 'passphrase' }, async (url, init) => {
      expect(url).toContain('chainIndex=196')
      expect(url).toContain('priceImpactProtectionPercent=25')
      expect(init?.headers).toMatchObject({ 'OK-ACCESS-KEY': 'key', 'OK-ACCESS-PASSPHRASE': 'passphrase' })
      return new Response(JSON.stringify({
        code: '0',
        data: [{
          tx: { to: '0x722db4f285F8bD91ef7AF6DA397e83f7fA4E80a7', data: '0x12345678', value: '0', minReceiveAmount: '42', slippagePercent: '0.5' },
          routerResult: {
            chainIndex: '196', fromTokenAmount: input.amount, toTokenAmount: '42', priceImpactPercent: '12.4',
            dexRouterList: [{ dexProtocol: { dexName: 'DYORSwap' } }, { dexProtocol: { dexName: 'DYORSwap' } }],
          },
        }],
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }, '2026-07-18T00:00:00.000Z')
    expect(quote).toEqual({
      transaction: { chainId: 196, to: '0x722db4f285f8bd91ef7af6da397e83f7fa4e80a7', data: '0x12345678', valueWei: '0' },
      route: { fromTokenAmount: input.amount, toTokenAmount: '42', minimumReceiveAmount: '42', priceImpactPercent: '12.4', slippagePercent: '0.5', protocols: ['DYORSwap'], observedAt: '2026-07-18T00:00:00.000Z' },
    })
  })

  it('rejects an unsuccessful or incomplete provider envelope', async () => {
    await expect(requestOkxDexQuote(input, { apiKey: 'key', secretKey: 'secret', passphrase: 'passphrase' }, async () => new Response(JSON.stringify({ code: '500', data: [] }), { status: 200 }))).rejects.toThrow('did not return one successful quote')
  })
})
