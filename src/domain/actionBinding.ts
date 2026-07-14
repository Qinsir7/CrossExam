import type { ActionBinding, ActionType } from './types'

/** Creates an execution binding without exposing raw action parameters in later preflight calls. */
export async function createActionBinding(actionType: ActionType, target: string, parameters: string): Promise<ActionBinding> {
  const normalizedTarget = target.trim()
  const normalizedParameters = parameters.trim()
  if (!normalizedTarget || !normalizedParameters) throw new Error('An action target and parameters are required for an execution binding.')
  const encoded = new TextEncoder().encode(JSON.stringify({ actionType, target: normalizedTarget, parameters: normalizedParameters }))
  const digest = await crypto.subtle.digest('SHA-256', encoded)
  const hash = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
  return { actionType, target: normalizedTarget, parametersHash: `0x${hash}` }
}
