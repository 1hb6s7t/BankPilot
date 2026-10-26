export class CoreError extends Error {
  constructor(public code: string, message: string, public statusCode = 409) {
    super(message);
    this.name = 'CoreError';
  }
  get status() { return this.statusCode; }
}
