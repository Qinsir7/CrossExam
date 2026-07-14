export type X402ServerConfig = {
  port: number
  payTo: `0x${string}`
  priceUsd: string
  okxApiKey: string
  okxSecretKey: string
  okxPassphrase: string
  syncFacilitatorOnStart: boolean
  reviewerWallets: Record<string, `0x${string}`>
  dataDirectory: string
  recordAccessTtlSeconds: number
}

type Environment = Record<string, string | undefined>

function required(env: Environment, key: string) {
  const value = env[key]?.trim()
  if (!value) throw new Error(`Missing required environment variable: ${key}`)
  return value
}

function positiveDollarPrice(value: string) {
  const amount = Number(value)
  if (!Number.isFinite(amount) || amount <= 0 || amount > 10) {
    throw new Error('CROSSEXAM_X402_PRICE_USD must be a positive amount no greater than 10.')
  }
  return amount.toFixed(2)
}

function booleanEnvironment(value: string | undefined, fallback: boolean) {
  if (value === undefined) return fallback
  if (value === 'true') return true
  if (value === 'false') return false
  throw new Error('CROSSEXAM_X402_SYNC must be "true" or "false".')
}

function reviewerWalletRegistry(value: string | undefined): Record<string, `0x${string}`> {
  if (!value?.trim()) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    throw new Error('CROSSEXAM_REVIEWER_WALLETS must be valid JSON.')
  }
  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') {
    throw new Error('CROSSEXAM_REVIEWER_WALLETS must be a reviewer-id to EVM-address object.')
  }
  const registry: Record<string, `0x${string}`> = {}
  for (const [reviewerId, wallet] of Object.entries(parsed)) {
    if (!reviewerId.trim() || typeof wallet !== 'string' || !/^0x[a-fA-F0-9]{40}$/.test(wallet)) {
      throw new Error('CROSSEXAM_REVIEWER_WALLETS contains an invalid reviewer wallet binding.')
    }
    registry[reviewerId] = wallet as `0x${string}`
  }
  return registry
}

function recordAccessTtl(value: string | undefined) {
  const ttl = Number(value ?? '2592000')
  if (!Number.isInteger(ttl) || ttl < 60 || ttl > 31_536_000) throw new Error('CROSSEXAM_RECORD_ACCESS_TTL_SECONDS must be between 60 and 31536000.')
  return ttl
}

/** Reads the seller-only configuration. Do not expose any of these values to Vite. */
export function loadX402ServerConfig(env: Environment = process.env): X402ServerConfig {
  const payTo = required(env, 'CROSSEXAM_PAY_TO')
  if (!/^0x[a-fA-F0-9]{40}$/.test(payTo)) {
    throw new Error('CROSSEXAM_PAY_TO must be a 20-byte EVM address.')
  }

  const port = Number(env.CROSSEXAM_PORT ?? '4022')
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('CROSSEXAM_PORT must be a valid TCP port.')
  }

  return {
    port,
    payTo: payTo as `0x${string}`,
    priceUsd: positiveDollarPrice(env.CROSSEXAM_X402_PRICE_USD ?? '0.02'),
    okxApiKey: required(env, 'OKX_API_KEY'),
    okxSecretKey: required(env, 'OKX_SECRET_KEY'),
    okxPassphrase: required(env, 'OKX_PASSPHRASE'),
    syncFacilitatorOnStart: booleanEnvironment(env.CROSSEXAM_X402_SYNC, true),
    reviewerWallets: reviewerWalletRegistry(env.CROSSEXAM_REVIEWER_WALLETS),
    dataDirectory: env.CROSSEXAM_DATA_DIR?.trim() || '.crossexam-data',
    recordAccessTtlSeconds: recordAccessTtl(env.CROSSEXAM_RECORD_ACCESS_TTL_SECONDS),
  }
}
