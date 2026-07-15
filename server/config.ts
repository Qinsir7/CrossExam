import { privateKeyToAccount } from 'viem/accounts'
import type { Address, Hex } from 'viem'
import type { ReviewerRegistry } from './reviewerRegistry'

export type X402ServerConfig = {
  port: number
  payTo: `0x${string}`
  priceUsd: string
  okxApiKey: string
  okxSecretKey: string
  okxPassphrase: string
  syncFacilitatorOnStart: boolean
  serviceSigningKey?: Hex
  serviceSignerAddress?: Address
  reviewerRegistry: ReviewerRegistry
  procurementSigningKey?: Hex
  procurementMaxPerScopeAtomic?: bigint
  procurementAllowedAssets: string[]
  outcomeAuthorityWallets: Record<string, `0x${string}`>
  executorWallets: Record<string, `0x${string}`>
  dataDirectory: string
  recordAccessTtlSeconds: number
  databaseUrl?: string
  publicUrl?: string
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

function privateKeySigner(value: string | undefined, label: string) {
  const privateKey = value?.trim()
  if (!privateKey) return undefined
  if (!/^0x[a-fA-F0-9]{64}$/.test(privateKey)) throw new Error(`${label} must be a 32-byte EVM private key.`)
  const key = privateKey as Hex
  return { key, address: privateKeyToAccount(key).address }
}

function walletRegistry(value: string | undefined, label: string): Record<string, `0x${string}`> {
  if (!value?.trim()) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    throw new Error(`${label} must be valid JSON.`)
  }
  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') {
    throw new Error(`${label} must be an identifier to EVM-address object.`)
  }
  const registry: Record<string, `0x${string}`> = {}
  for (const [reviewerId, wallet] of Object.entries(parsed)) {
    if (!reviewerId.trim() || typeof wallet !== 'string' || !/^0x[a-fA-F0-9]{40}$/.test(wallet)) {
      throw new Error(`${label} contains an invalid wallet binding.`)
    }
    registry[reviewerId] = wallet as `0x${string}`
  }
  return registry
}

function reviewerRegistry(value: string | undefined): ReviewerRegistry {
  if (!value?.trim()) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    throw new Error('CROSSEXAM_REVIEWER_REGISTRY must be valid JSON.')
  }
  if (!Array.isArray(parsed)) throw new Error('CROSSEXAM_REVIEWER_REGISTRY must be a JSON array.')

  const registry: ReviewerRegistry = {}
  const wallets = new Set<string>()
  for (const item of parsed) {
    if (!item || typeof item !== 'object') throw new Error('CROSSEXAM_REVIEWER_REGISTRY contains an invalid reviewer.')
    const candidate = item as Record<string, unknown>
    const id = typeof candidate.id === 'string' ? candidate.id.trim() : ''
    const displayName = typeof candidate.displayName === 'string' ? candidate.displayName.trim() : ''
    const ownerId = typeof candidate.ownerId === 'string' ? candidate.ownerId.trim() : ''
    const modelFamily = typeof candidate.modelFamily === 'string' ? candidate.modelFamily.trim() : ''
    const wallet = typeof candidate.wallet === 'string' ? candidate.wallet : ''
    const procurementEndpoint = typeof candidate.procurementEndpoint === 'string' ? candidate.procurementEndpoint.trim() : undefined
    const status = candidate.status === undefined ? 'ACTIVE' : candidate.status
    const evidenceRoutes = candidate.evidenceRoutes
    const capabilities = candidate.capabilities
    if (!id || !displayName || !ownerId || !modelFamily
      || !/^0x[a-fA-F0-9]{40}$/.test(wallet)
      || (procurementEndpoint !== undefined && !/^https:\/\/.+/.test(procurementEndpoint))
      || (status !== 'ACTIVE' && status !== 'SUSPENDED')
      || !Array.isArray(evidenceRoutes) || !evidenceRoutes.length || evidenceRoutes.some((route) => typeof route !== 'string' || !route.trim())
      || !Array.isArray(capabilities) || !capabilities.length || capabilities.some((capability) => typeof capability !== 'string' || !capability.trim())
      || registry[id] || wallets.has(wallet.toLowerCase())) {
      throw new Error('CROSSEXAM_REVIEWER_REGISTRY contains an invalid or duplicate reviewer binding.')
    }
    wallets.add(wallet.toLowerCase())
    registry[id] = {
      id,
      displayName,
      ownerId,
      modelFamily,
      wallet: wallet as Address,
      status,
      ...(procurementEndpoint ? { procurementEndpoint } : {}),
      evidenceRoutes: evidenceRoutes as string[],
      capabilities: capabilities as string[],
    }
  }
  return registry
}

function positiveAtomicAmount(value: string | undefined, label: string) {
  if (!value?.trim()) return undefined
  if (!/^[1-9][0-9]{0,29}$/.test(value)) throw new Error(`${label} must be a positive atomic token amount.`)
  return BigInt(value)
}

function allowedAssets(value: string | undefined) {
  if (!value?.trim()) return []
  const assets = value.split(',').map((asset) => asset.trim()).filter(Boolean)
  if (!assets.length || assets.some((asset) => !/^0x[a-fA-F0-9]{40}$/.test(asset))) {
    throw new Error('CROSSEXAM_PROCUREMENT_ALLOWED_ASSETS must be a comma-separated EVM token-address list.')
  }
  return assets.map((asset) => asset.toLowerCase())
}

function recordAccessTtl(value: string | undefined) {
  const ttl = Number(value ?? '2592000')
  if (!Number.isInteger(ttl) || ttl < 60 || ttl > 31_536_000) throw new Error('CROSSEXAM_RECORD_ACCESS_TTL_SECONDS must be between 60 and 31536000.')
  return ttl
}

function databaseUrl(value: string | undefined) {
  const candidate = value?.trim()
  if (!candidate) return undefined
  let parsed: URL
  try {
    parsed = new URL(candidate)
  } catch {
    throw new Error('CROSSEXAM_DATABASE_URL must be a valid PostgreSQL connection URL.')
  }
  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    throw new Error('CROSSEXAM_DATABASE_URL must use the postgres or postgresql protocol.')
  }
  return candidate
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

  const signer = privateKeySigner(env.CROSSEXAM_SERVICE_SIGNING_KEY, 'CROSSEXAM_SERVICE_SIGNING_KEY')
  const procurementSigner = privateKeySigner(env.CROSSEXAM_PROCUREMENT_SIGNING_KEY, 'CROSSEXAM_PROCUREMENT_SIGNING_KEY')
  const procurementMaxPerScopeAtomic = positiveAtomicAmount(env.CROSSEXAM_PROCUREMENT_MAX_PER_SCOPE_ATOMIC, 'CROSSEXAM_PROCUREMENT_MAX_PER_SCOPE_ATOMIC')
  const procurementAllowedAssets = allowedAssets(env.CROSSEXAM_PROCUREMENT_ALLOWED_ASSETS)
  if (procurementSigner && (!procurementMaxPerScopeAtomic || procurementAllowedAssets.length === 0)) {
    throw new Error('Procurement signing requires CROSSEXAM_PROCUREMENT_MAX_PER_SCOPE_ATOMIC and CROSSEXAM_PROCUREMENT_ALLOWED_ASSETS.')
  }
  const syncFacilitatorOnStart = booleanEnvironment(env.CROSSEXAM_X402_SYNC, true)
  if (syncFacilitatorOnStart && !signer) {
    throw new Error('CROSSEXAM_SERVICE_SIGNING_KEY is required when CROSSEXAM_X402_SYNC=true.')
  }

  return {
    port,
    payTo: payTo as `0x${string}`,
    priceUsd: positiveDollarPrice(env.CROSSEXAM_X402_PRICE_USD ?? '0.02'),
    okxApiKey: required(env, 'OKX_API_KEY'),
    okxSecretKey: required(env, 'OKX_SECRET_KEY'),
    okxPassphrase: required(env, 'OKX_PASSPHRASE'),
    syncFacilitatorOnStart,
    serviceSigningKey: signer?.key,
    serviceSignerAddress: signer?.address,
    reviewerRegistry: reviewerRegistry(env.CROSSEXAM_REVIEWER_REGISTRY),
    procurementSigningKey: procurementSigner?.key,
    procurementMaxPerScopeAtomic,
    procurementAllowedAssets,
    outcomeAuthorityWallets: walletRegistry(env.CROSSEXAM_OUTCOME_AUTHORITY_WALLETS, 'CROSSEXAM_OUTCOME_AUTHORITY_WALLETS'),
    executorWallets: walletRegistry(env.CROSSEXAM_EXECUTOR_WALLETS, 'CROSSEXAM_EXECUTOR_WALLETS'),
    dataDirectory: env.CROSSEXAM_DATA_DIR?.trim() || '.crossexam-data',
    recordAccessTtlSeconds: recordAccessTtl(env.CROSSEXAM_RECORD_ACCESS_TTL_SECONDS),
    databaseUrl: databaseUrl(env.CROSSEXAM_DATABASE_URL),
    publicUrl: env.CROSSEXAM_PUBLIC_URL?.trim() || undefined,
  }
}
