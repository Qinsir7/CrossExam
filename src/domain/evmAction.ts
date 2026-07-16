import type { ActionBinding, ActionType, ReviewEvidenceContext } from './types'
import { createActionBinding } from './actionBinding'

export type EvmActionInput = {
  actionType: ActionType
  chainId: number
  /** Omit only for a contract creation transaction. */
  to?: string
  data: string
  valueWei?: string
  /** The asset or contract that an independent risk source should inspect. */
  tokenRiskTarget?: string
}

function address(value: string) {
  if (!/^0x[a-fA-F0-9]{40}$/.test(value)) throw new Error('An EVM action target must be a 20-byte 0x address.')
  return value.toLowerCase()
}

function normalizedTokenRiskTarget(value: string) {
  const matched = /^token:([a-z0-9_-]+):(0x[a-fA-F0-9]{40})$/.exec(value)
  if (!matched) throw new Error('Token risk target must use token:<chain>:0x<contract-address>.')
  return `token:${matched[1]}:${matched[2].toLowerCase()}`
}

/** Canonicalizes transaction-shaped inputs before binding their exact payload hash. */
export async function createEvmActionBinding(input: EvmActionInput): Promise<{ actionBinding: ActionBinding; reviewEvidenceContext?: ReviewEvidenceContext }> {
  if (!Number.isInteger(input.chainId) || input.chainId < 1 || input.chainId > 9_999_999) throw new Error('EVM chain ID must be a positive integer.')
  if (!/^0x(?:[a-fA-F0-9]{2})*$/.test(input.data)) throw new Error('EVM calldata must be an even-length 0x hex string.')
  const valueWei = input.valueWei?.trim() || '0'
  if (!/^(0|[1-9][0-9]{0,77})$/.test(valueWei)) throw new Error('EVM value must be a non-negative integer amount in wei.')
  const contractCreation = input.to === undefined || input.to.trim() === ''
  if (contractCreation && input.actionType !== 'DEPLOY') throw new Error('Only DEPLOY actions may omit an EVM transaction recipient.')
  if (contractCreation && input.data === '0x') throw new Error('A deployment action requires non-empty init code.')
  const target = contractCreation ? `evm:${input.chainId}:create` : `evm:${input.chainId}:${address(input.to!)}`
  const parameters = JSON.stringify({
    chainId: input.chainId,
    ...(contractCreation ? { to: null } : { to: address(input.to!) }),
    data: input.data.toLowerCase(),
    valueWei,
  })
  const context = input.tokenRiskTarget ? { tokenRiskTarget: normalizedTokenRiskTarget(input.tokenRiskTarget) } : undefined
  return { actionBinding: await createActionBinding(input.actionType, target, parameters), ...(context ? { reviewEvidenceContext: context } : {}) }
}
