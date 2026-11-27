/** A request a module refuses by its rules (bad input, wrong state). Routes turn it into a 400. */
export class DomainError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "DomainError";
  }
}

/** The thing asked for doesn't exist, or isn't the caller's. Routes turn it into a 404. */
export class NotFoundError extends Error {
  constructor(readonly what: string) {
    super(`${what} not found.`);
    this.name = "NotFoundError";
  }
}
