/** Error carrying an HTTP status. Thrown by the orchestrator for invalid requests. */
export class HarnessError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export const badRequest = (msg: string) => new HarnessError(400, msg);
export const notFound = (msg: string) => new HarnessError(404, msg);
export const conflict = (msg: string) => new HarnessError(409, msg);
