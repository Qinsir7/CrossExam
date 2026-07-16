import { describe, expect, it } from 'vitest'
import { createEvmActionBinding } from './evmAction'

describe('createEvmActionBinding', () => {
  it('binds canonical EVM transaction fields and a distinct token-risk target', async () => {
    const action = await createEvmActionBinding({
      actionType: 'TRADE', chainId: 1, to: '0x1111111111111111111111111111111111111111', data: '0xAABB', valueWei: '1000', tokenRiskTarget: 'token:eth:0x2222222222222222222222222222222222222222',
    })
    expect(action.actionBinding.target).toBe('evm:1:0x1111111111111111111111111111111111111111')
    expect(action.reviewEvidenceContext).toEqual({ tokenRiskTarget: 'token:eth:0x2222222222222222222222222222222222222222' })
  })

  it('permits recipient-less CREATE only for deployment init code', async () => {
    await expect(createEvmActionBinding({ actionType: 'DEPLOY', chainId: 196, data: '0x6000' })).resolves.toMatchObject({ actionBinding: { target: 'evm:196:create' } })
    await expect(createEvmActionBinding({ actionType: 'TRADE', chainId: 196, data: '0x' })).rejects.toThrow('DEPLOY')
  })
})
