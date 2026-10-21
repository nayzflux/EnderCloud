export class ApplicationError extends Error {
  public constructor(public readonly code: string, public readonly status: number, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ApplicationError";
  }
}

export type RequestAuthorizer = (request: Request) => void | Promise<void>;

export const denyUnauthorized: RequestAuthorizer = () => {
  throw new ApplicationError("UNAUTHORIZED", 401, "Authentication required");
};
