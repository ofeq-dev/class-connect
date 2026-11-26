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
