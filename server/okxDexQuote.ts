import { createHmac } from 'node:crypto'

const OKX_DEX_SWAP_URL = 'https://web3.okx.com/api/v6/dex/aggregator/swap'
const XLAYER_CHAIN_ID = 196

type OkxCredentials = {
  apiKey: string
  secretKey: string
  passphrase: string
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

export type OkxDexQuoteRequest = {
  fromTokenAddress: string
  toTokenAddress: string
  amount: string
  slippagePercent: string
  userWalletAddress: string
}

export type OkxDexQuote = {
  transaction: {
    chainId: typeof XLAYER_CHAIN_ID
    to: `0x${string}`
    data: `0x${string}`
    valueWei: string
  }
  route: {
    fromTokenAmount: string
    toTokenAmount: string
    minimumReceiveAmount?: string
    priceImpactPercent?: string
    slippagePercent?: string
    protocols: string[]
    observedAt: string
  }
}

function positiveAtomic(value: unknown, label: string) {
  if (typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value)) throw new Error(`${label} must be a positive whole token-unit amount.`)
  return value
}

function nonNegativeAtomic(value: unknown, label: string) {
  if (typeof value !== 'string' || !/^(?:0|[1-9][0-9]*)$/.test(value)) throw new Error(`${label} must be a non-negative whole wei amount.`)
  return value
}

function address(value: unknown, label: string): `0x${string}` {
  if (typeof value !== 'string' || !/^0x[a-fA-F0-9]{40}$/.test(value)) throw new Error(`${label} must be a 20-byte EVM address.`)
  return value.toLowerCase() as `0x${string}`
}

function hex(value: unknown, label: string): `0x${string}` {
  if (typeof value !== 'string' || !/^0x(?:[a-fA-F0-9]{2})+$/.test(value)) throw new Error(`${label} must be non-empty even-length 0x hex.`)
  return value.toLowerCase() as `0x${string}`
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error(`${label} must be an object.`)
  return value as Record<string, unknown>
}

function decimalPercent(value: unknown) {
  if (typeof value !== 'string' || !/^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,9})?$/.test(value)) throw new Error('Slippage must be a decimal percentage.')
  const parsed = Number(value)
  // CrossExam is not a trade execution system. A conservative quote cap avoids
  // accidentally preparing a route whose protection settings defeat the
  // purpose of the subsequent preflight.
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 5) throw new Error('Slippage must be greater than 0% and no more than 5%.')
  return value
}

function stringField(value: unknown, label: string) {
  if (typeof value !== 'string' || !value) throw new Error(`${label} is missing from the OKX DEX quote.`)
  return value
}

/**
 * Validates a quote request before it reaches the authenticated OKX DEX API.
 * This endpoint is intentionally X Layer-only and emits no approval or
 * broadcast request; it exists solely to bind a proposed swap to review.
 */
export function validateOkxDexQuoteRequest(input: OkxDexQuoteRequest) {
  const fromTokenAddress = address(input.fromTokenAddress, 'From-token address')
  const toTokenAddress = address(input.toTokenAddress, 'To-token address')
  if (fromTokenAddress === toTokenAddress) throw new Error('The input and output tokens must differ.')
  return {
    fromTokenAddress,
    toTokenAddress,
    amount: positiveAtomic(input.amount, 'Amount'),
    slippagePercent: decimalPercent(input.slippagePercent),
    userWalletAddress: address(input.userWalletAddress, 'Wallet address'),
  }
}

export function okxAuthenticatedGetHeaders(url: string, credentials: OkxCredentials) {
  const parsed = new URL(url)
  const requestPath = `${parsed.pathname}${parsed.search}`
  const timestamp = new Date().toISOString()
  const signature = createHmac('sha256', credentials.secretKey).update(`${timestamp}GET${requestPath}`).digest('base64')
  return {
    'OK-ACCESS-KEY': credentials.apiKey,
    'OK-ACCESS-SIGN': signature,
    'OK-ACCESS-PASSPHRASE': credentials.passphrase,
    'OK-ACCESS-TIMESTAMP': timestamp,
  }
}

export async function requestOkxDexQuote(
  input: OkxDexQuoteRequest,
  credentials: OkxCredentials,
  fetcher: FetchLike = fetch,
  observedAt = new Date().toISOString(),
): Promise<OkxDexQuote> {
  const request = validateOkxDexQuoteRequest(input)
  const url = new URL(OKX_DEX_SWAP_URL)
  url.search = new URLSearchParams({
    chainIndex: String(XLAYER_CHAIN_ID),
    amount: request.amount,
    swapMode: 'exactIn',
    fromTokenAddress: request.fromTokenAddress,
    toTokenAddress: request.toTokenAddress,
    slippagePercent: request.slippagePercent,
    userWalletAddress: request.userWalletAddress,
    // Reject routes with extreme price impact before a user is ever invited to
    // pay CrossExam for its evidence review. This is a quote constraint, not
    // a CrossExam safety verdict.
    priceImpactProtectionPercent: '25',
  }).toString()
  const response = await fetcher(url.toString(), { method: 'GET', headers: okxAuthenticatedGetHeaders(url.toString(), credentials) })
  const body = await response.json().catch(() => undefined)
  if (!response.ok) throw new Error(`OKX DEX quote request failed with HTTP ${response.status}.`)
  const envelope = object(body, 'OKX DEX response')
  if (envelope.code !== '0' || !Array.isArray(envelope.data) || envelope.data.length !== 1) throw new Error('OKX DEX did not return one successful quote.')
  const quote = object(envelope.data[0], 'OKX DEX quote')
  const tx = object(quote.tx, 'OKX DEX quote transaction')
  const routerResult = object(quote.routerResult, 'OKX DEX route')
  if (routerResult.chainIndex !== String(XLAYER_CHAIN_ID)) throw new Error('OKX DEX returned a route outside X Layer.')
  const protocolRows = Array.isArray(routerResult.dexRouterList) ? routerResult.dexRouterList : []
  const protocols = [...new Set(protocolRows.flatMap((row) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) return []
    const protocol = (row as Record<string, unknown>).dexProtocol
    if (!protocol || typeof protocol !== 'object' || Array.isArray(protocol)) return []
    const name = (protocol as Record<string, unknown>).dexName
    return typeof name === 'string' && name ? [name] : []
  }))]
  if (!protocols.length) throw new Error('OKX DEX quote did not identify a routed liquidity protocol.')

  return {
    transaction: {
      chainId: XLAYER_CHAIN_ID,
      to: address(tx.to, 'OKX DEX router address'),
      data: hex(tx.data, 'OKX DEX transaction calldata'),
      valueWei: nonNegativeAtomic(tx.value ?? '0', 'OKX DEX transaction value'),
    },
    route: {
      fromTokenAmount: stringField(routerResult.fromTokenAmount, 'Input amount'),
      toTokenAmount: stringField(routerResult.toTokenAmount, 'Output amount'),
      ...(typeof tx.minReceiveAmount === 'string' ? { minimumReceiveAmount: tx.minReceiveAmount } : {}),
      ...(typeof routerResult.priceImpactPercent === 'string' ? { priceImpactPercent: routerResult.priceImpactPercent } : {}),
      ...(typeof tx.slippagePercent === 'string' ? { slippagePercent: tx.slippagePercent } : {}),
      protocols,
      observedAt,
    },
  }
}
