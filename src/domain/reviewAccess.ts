export function reviewAccessRecoveryMessage(input: { transaction: string; issuedAt: string }) {
  return [
    'CrossExam paid review access recovery',
    `Transaction: ${input.transaction.toLowerCase()}`,
    `Issued at: ${input.issuedAt}`,
    'Purpose: rotate the owner capability for the review funded by this wallet.',
  ].join('\n')
}
