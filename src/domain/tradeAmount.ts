/** Convert a human USDT0 amount into its six-decimal X Layer atomic value. */
export function usdt0Atomic(value: string) {
  const normalized = value.trim()
  if (!/^(?:0|[1-9][0-9]{0,8})(?:\.[0-9]{1,6})?$/.test(normalized)) {
    throw new Error('Enter a USDT0 amount with no more than 6 decimal places.')
  }
  const [whole, fraction = ''] = normalized.split('.')
  const atomic = BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, '0'))
  if (atomic <= 0n) throw new Error('The trade amount must be greater than 0 USDT0.')
  return atomic.toString()
}
