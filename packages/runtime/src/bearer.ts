import { createHash, timingSafeEqual } from "node:crypto";
import { ApplicationError } from "@endercloud/contracts/errors";

export function bearerAuthorizer(secret: string) {
  if (secret.length < 32) throw new Error("A control token of at least 32 characters is required");
  const expected = createHash("sha256").update(secret).digest();
  return (request: Request): void => {
    const token = request.headers.get("authorization")?.match(/^Bearer (\S+)$/i)?.[1] ?? "";
    if (!timingSafeEqual(expected, createHash("sha256").update(token).digest())) {
      throw new ApplicationError("UNAUTHORIZED", 401, "Invalid control credential");
    }
  };
}
