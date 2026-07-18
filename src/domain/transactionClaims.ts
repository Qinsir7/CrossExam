import type { AssuranceAction } from './assuranceAction'
import type { DecisionClaim } from './types'

export type TransactionClaimCategory =
  | 'ACTION_BINDING'
  | 'ASSET_TARGET'
  | 'EXECUTION_LIQUIDITY'
  | 'TOKEN_TRANSFER_SAFETY'
  | 'APPROVAL_SCOPE'
  | 'NATIVE_VALUE_SCOPE'

export type CompiledTransactionClaim = DecisionClaim & {
  category: TransactionClaimCategory
  requiredSourceIds: string[]
}

export type ApprovalInspection = {
  kind: 'ERC20_APPROVE' | 'ERC20_ALLOWANCE_CHANGE' | 'OPERATOR_APPROVAL' | 'ERC20_PERMIT'
  selector: `0x${string}`
  spender?: `0x${string}`
  amount?: bigint
  unlimited: boolean
}

export type TransactionInspection = {
  selector?: `0x${string}`
  approval?: ApprovalInspection
  nativeValueWei: bigint
}

export type CompiledTransactionClaims = {
  claims: CompiledTransactionClaim[]
  inspection: TransactionInspection
  limitations: string[]
}

const MAX_UINT256 = (1n << 256n) - 1n

function selector(data: string): `0x${string}` | undefined {
  return data.length >= 10 ? data.slice(0, 10) as `0x${string}` : undefined
}

function calldataWord(data: string, index: number) {
  const start = 10 + index * 64
  const end = start + 64
  return data.length >= end ? data.slice(start, end) : undefined
}

function addressFromWord(word: string | undefined) {
  if (!word || !/^[a-f0-9]{64}$/i.test(word)) return undefined
  return `0x${word.slice(-40).toLowerCase()}` as `0x${string}`
}

function amountFromWord(word: string | undefined) {
  if (!word || !/^[a-f0-9]{64}$/i.test(word)) return undefined
  return BigInt(`0x${word}`)
}

/**
 * Decodes only a deliberately small, known-safe subset of approval-shaped
 * calldata. Unknown selectors are left opaque; CrossExam must not guess ABI
 * semantics from arbitrary bytes.
 */
export function inspectTransaction(action: AssuranceAction): TransactionInspection {
  if (!action.evm) throw new Error('Transaction claim compilation requires a canonical EVM action.')
  const dataSelector = selector(action.evm.data)
  const first = calldataWord(action.evm.data, 0)
  const second = calldataWord(action.evm.data, 1)
  const spender = addressFromWord(first)
  const amount = amountFromWord(second)
  let approval: ApprovalInspection | undefined

  if (dataSelector === '0x095ea7b3') {
    approval = { kind: 'ERC20_APPROVE', selector: dataSelector, spender, amount, unlimited: amount === MAX_UINT256 }
  } else if (dataSelector === '0x39509351' || dataSelector === '0xa457c2d7') {
    approval = { kind: 'ERC20_ALLOWANCE_CHANGE', selector: dataSelector, spender, amount, unlimited: amount === MAX_UINT256 }
  } else if (dataSelector === '0xa22cb465') {
    approval = { kind: 'OPERATOR_APPROVAL', selector: dataSelector, spender, unlimited: second?.endsWith('1') ?? false }
  } else if (dataSelector === '0xd505accf') {
    approval = { kind: 'ERC20_PERMIT', selector: dataSelector, spender, amount, unlimited: amount === MAX_UINT256 }
  }

  return {
    ...(dataSelector ? { selector: dataSelector } : {}),
    ...(approval ? { approval } : {}),
    nativeValueWei: BigInt(action.evm.valueWei),
  }
}

function claim(id: string, statement: string, category: TransactionClaimCategory, requiredSourceIds: string[] = []): CompiledTransactionClaim {
  return { id, statement, materiality: 1, category, requiredSourceIds }
}

/**
 * Deterministically derives the material premises for a transaction review.
 * It creates reviewable claims, never a verdict. Missing token context remains
 * visible as a limitation so later policy fails closed instead of guessing the
 * asset being traded through a router.
 */
export function compileTransactionClaims(action: AssuranceAction): CompiledTransactionClaims {
  if (!action.evm) throw new Error('Transaction claim compilation requires a canonical EVM action.')
  const inspection = inspectTransaction(action)
  const claims: CompiledTransactionClaim[] = [
    claim(
      'C-ACTION-BINDING',
      'The reviewed chain, recipient, calldata, and native value exactly match the action presented to the executor.',
      'ACTION_BINDING',
    ),
  ]
  const limitations: string[] = []

  if (action.binding.actionType === 'TRADE') {
    if (action.reviewEvidenceContext?.tokenRiskTarget) {
      claims.push(
        claim(
          'C-EXECUTION-LIQUIDITY',
          'Observed X Layer liquidity clears CrossExam\'s conservative evidence-screening floor for the reviewed trade size.',
          'EXECUTION_LIQUIDITY',
          ['okx-onchainos-liquidity'],
        ),
        claim(
          'C-TOKEN-TRANSFER-SAFETY',
          'The reviewed token has no deterministic transfer, sell, blacklist, honeypot, source-availability, or critical-tax control that violates CrossExam\'s supported GoPlus policy.',
          'TOKEN_TRANSFER_SAFETY',
          ['goplus-xlayer-token-risk'],
        ),
      )
    } else {
      claims.push(claim(
        'C-ASSET-TARGET',
        'The asset to be acquired is explicitly identified so independent liquidity and contract-risk evidence can be bound to it.',
        'ASSET_TARGET',
      ))
      limitations.push('No token risk target was supplied. CrossExam cannot safely infer the traded asset from arbitrary router calldata.')
    }
  }

  if (inspection.approval) {
    claims.push(claim(
      'C-APPROVAL-SCOPE',
      inspection.approval.unlimited
        ? 'The transaction does not grant an unlimited token or operator approval that exceeds CrossExam approval policy.'
        : 'The transaction approval scope and operator are acceptable for the reviewed action.',
      'APPROVAL_SCOPE',
    ))
  }

  if (inspection.nativeValueWei > 0n) {
    claims.push(claim(
      'C-NATIVE-VALUE-SCOPE',
      'The exact native value transferred by the transaction is within the reviewed action scope.',
      'NATIVE_VALUE_SCOPE',
    ))
  }

  return { claims, inspection, limitations }
}
