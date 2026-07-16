import type { Address } from 'viem'

const XLAYER_CHAIN_ID = 196
const XLAYER_USDT0 = '0x779ded0c9e1022225f8e0630b35a9b54be713736'

type InjectedProvider = {
  request(args: { method: string; params?: unknown[] | Record<string, unknown> }): Promise<unknown>
}

declare global {
  interface Window { ethereum?: InjectedProvider }
}

export type BrowserPaymentPreview = {
  network: string
  asset: string
  amountAtomic: string
  payTo: string
  description?: string
}

function injectedProvider() {
  if (!window.ethereum) throw new Error('No browser wallet was found. Open this page in OKX Wallet or another X Layer-compatible wallet.')
  return window.ethereum
}

/**
 * Executes exactly one browser-wallet x402 request. The caller receives the
 * challenge details and must explicitly approve before an EIP-712 payment
 * authorization is signed. CrossExam never receives the wallet private key.
 */
export async function fetchWithBrowserX402(
  input: string,
  init: RequestInit,
  confirm: (preview: BrowserPaymentPreview) => boolean | Promise<boolean>,
  expectedAmountAtomic?: string,
): Promise<Response> {
  if (expectedAmountAtomic !== undefined && !/^[1-9][0-9]*$/.test(expectedAmountAtomic)) throw new Error('The expected x402 amount is invalid.')
  const provider = injectedProvider()
  const accounts = await provider.request({ method: 'eth_requestAccounts' })
  const address = Array.isArray(accounts) && typeof accounts[0] === 'string' ? accounts[0] as Address : undefined
  if (!address || !/^0x[a-fA-F0-9]{40}$/.test(address)) throw new Error('The connected wallet did not return an EVM account.')
  try {
    await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: `0x${XLAYER_CHAIN_ID.toString(16)}` }] })
  } catch {
    throw new Error('Switch the connected wallet to X Layer (chain ID 196) before authorizing this review.')
  }

  // Payment libraries are loaded only when the user actually enters the
  // wallet flow. The public decision workspace stays small and fast.
  const [{ x402Client }, { x402HTTPClient }, { ExactEvmScheme, toClientEvmSigner }, { createWalletClient, custom }] = await Promise.all([
    import('@okxweb3/x402-core/client'),
    import('@okxweb3/x402-core/http'),
    import('@okxweb3/x402-evm'),
    import('viem'),
  ])
  const wallet = createWalletClient({ transport: custom(provider as Parameters<typeof custom>[0]), account: address })
  const core = x402Client.fromConfig({
    schemes: [{ network: 'eip155:196', client: new ExactEvmScheme(toClientEvmSigner({
      address,
      signTypedData: (message) => wallet.signTypedData(message as Parameters<typeof wallet.signTypedData>[0]),
    })) }],
    policies: [(_version, requirements) => requirements.filter((requirement) => (
      requirement.scheme === 'exact'
      && requirement.network === 'eip155:196'
      && requirement.asset.toLowerCase() === XLAYER_USDT0
      && /^[1-9][0-9]*$/.test(requirement.amount)
      && (expectedAmountAtomic === undefined || requirement.amount === expectedAmountAtomic)
      && /^0x[a-fA-F0-9]{40}$/.test(requirement.payTo)
    ))],
  })
  const http = new x402HTTPClient(core)
  const initial = await fetch(input, init)
  if (initial.status !== 402) return initial
  const required = http.getPaymentRequiredResponse((name) => initial.headers.get(name))
  const accepted = required.accepts.filter((requirement) => (
    requirement.scheme === 'exact'
    && requirement.network === 'eip155:196'
    && requirement.asset.toLowerCase() === XLAYER_USDT0
    && /^[1-9][0-9]*$/.test(requirement.amount)
    && (expectedAmountAtomic === undefined || requirement.amount === expectedAmountAtomic)
    && /^0x[a-fA-F0-9]{40}$/.test(requirement.payTo)
  ))
  if (!accepted.length) throw new Error('CrossExam returned a payment option outside the approved X Layer USDT0 amount and recipient policy.')
  const selected = accepted[0]
  const approved = await confirm({
    network: selected.network,
    asset: selected.asset,
    amountAtomic: selected.amount,
    payTo: selected.payTo,
    ...(required.resource.description ? { description: required.resource.description } : {}),
  })
  if (!approved) throw new Error('Payment authorization was cancelled before the wallet signed it.')
  const payment = await http.createPaymentPayload({ ...required, accepts: accepted })
  const headers: Record<string, string> = {}
  new Headers(init.headers).forEach((value, key) => { headers[key] = value })
  return fetch(input, { ...init, headers: { ...headers, ...http.encodePaymentSignatureHeader(payment) } })
}

export function displayUsdt0(amountAtomic: string) {
  if (!/^[1-9][0-9]*$/.test(amountAtomic)) return amountAtomic
  const value = BigInt(amountAtomic)
  const whole = value / 1_000_000n
  const fraction = (value % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '')
  return fraction ? `${whole}.${fraction}` : whole.toString()
}
