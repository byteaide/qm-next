export class NonRetryableTurnError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'NonRetryableTurnError'
  }
}
