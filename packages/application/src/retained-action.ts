/** Holds a connected creation request until its outcome is known. No automatic retries. */
export class RetainedAction<Command, Result> {
  private pending: { key: string; signature: string; command: Command } | null = null;
  private sending = false;
  async run(command: Command, nextKey: () => string, send: (command: Command, key: string) => Promise<Result>): Promise<Result> {
    if (this.sending) throw new Error('Please wait for the current change.');
    const signature = JSON.stringify(command);
    if (this.pending && this.pending.signature !== signature) throw new Error('The previous change has an unconfirmed outcome. Retry that exact change before starting another.');
    const request = this.pending ?? { key: nextKey(), signature, command: JSON.parse(signature) as Command };
    this.pending = request;
    this.sending = true;
    try {
      const result = await send(request.command, request.key);
      this.pending = null;
      return result;
    } catch (error) {
      // A rejected HTTP command has a known outcome. Timeouts, disconnects,
      // rate limits and server failures keep the original body and key.
      const status = error && typeof error === 'object' && 'status' in error ? Number(error.status) : 0;
      if (status >= 400 && status < 500 && ![408, 429].includes(status)) this.pending = null;
      throw error;
    } finally { this.sending = false; }
  }
}
