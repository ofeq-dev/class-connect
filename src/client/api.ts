import { hc, type ClientResponse } from "hono/client";
import type { SuccessStatusCode } from "hono/utils/http-status";
import type { AppType } from "../server/http";

export const api = hc<AppType>("/");

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** The body type of the success responses in a typed-client response union. */
type SuccessBody<R> =
  R extends ClientResponse<infer T, infer S, string>
    ? [Extract<S, SuccessStatusCode>] extends [never]
      ? never
      : T
    : never;

/** Unwraps a typed-client response, turning a refused request into an ApiError. */
export async function ok<R extends ClientResponse<unknown, number, string>>(
  res: R,
): Promise<SuccessBody<R>> {
  if (res.ok) return (await res.json()) as SuccessBody<R>;
  const body = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
  throw new ApiError(res.status, body.error ?? "unknown", body.message ?? "Something went wrong.");
}
