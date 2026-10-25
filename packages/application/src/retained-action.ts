/**
 * A later refusal does not settle an earlier attempt whose response was lost:
 * authentication, access or validation can run before idempotency lookup.
 */
export function retainedActionFailureIsUnconfirmed(error: unknown, previouslyUnconfirmed = false): boolean {
  if (previouslyUnconfirmed) return true;
  const status = error && typeof error === 'object' && 'status' in error ? Number(error.status) : 0;
  return !(status >= 400 && status < 500 && ![408, 429].includes(status));
}

/**
 * Holds a connected creation request until its outcome is known. No automatic
 * retries. The send port must validate its authoritative receipt before
 * resolving; a malformed or unverified response must reject instead.
 */
export class RetainedAction<Command, Result> {
  private pending: { key: string; signature: string; command: Command; outcomeUnconfirmed: boolean } | null = null;
  private sending = false;
  async run(command: Command, nextKey: () => string, send: (command: Command, key: string) => Promise<Result>): Promise<Result> {
    if (this.sending) throw new Error('Please wait for the current change.');
    const signature = JSON.stringify(command);
    if (this.pending && this.pending.signature !== signature) throw new Error('The previous change has an unconfirmed outcome. Retry that exact change before starting another.');
    const request = this.pending ?? { key: nextKey(), signature, command: JSON.parse(signature) as Command, outcomeUnconfirmed: false };
    this.pending = request;
    this.sending = true;
    try {
      const result = await send(request.command, request.key);
      this.pending = null;
      return result;
    } catch (error) {
      // Only a first-attempt definite refusal proves this request was not
      // accepted. Once any attempt is uncertain, later refusals cannot rule out
      // its earlier commit; keep its exact body/key until a receipt is returned.
      request.outcomeUnconfirmed = retainedActionFailureIsUnconfirmed(error, request.outcomeUnconfirmed);
      if (!request.outcomeUnconfirmed) this.pending = null;
      throw error;
    } finally { this.sending = false; }
  }
}
