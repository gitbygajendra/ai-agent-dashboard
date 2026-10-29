import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { logger } from "./logger";

/** An error whose message is safe to show to the user. */
export class AppError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 400,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export const Errors = {
  unauthorized: () => new AppError("UNAUTHORIZED", "Please sign in to continue.", 401),
  forbidden: (msg = "You don't have permission to do that.") => new AppError("FORBIDDEN", msg, 403),
  notFound: (what = "Resource") => new AppError("NOT_FOUND", `${what} not found.`, 404),
  rateLimited: (retryAfterSec: number) =>
    new AppError("RATE_LIMITED", `Too many requests. Try again in ${retryAfterSec}s.`, 429, { retryAfterSec }),
  invalid: (msg: string, details?: unknown) => new AppError("INVALID_INPUT", msg, 400, details),
  conflict: (msg: string) => new AppError("CONFLICT", msg, 409),
};

/** Convert any thrown value into a JSON response without leaking internals. */
export function toErrorResponse(err: unknown): NextResponse {
  if (err instanceof AppError) {
    const headers: Record<string, string> = {};
    if (err.code === "RATE_LIMITED" && err.details && typeof err.details === "object") {
      headers["Retry-After"] = String((err.details as { retryAfterSec: number }).retryAfterSec);
    }
    return NextResponse.json(
      { error: { code: err.code, message: err.message, details: err.details } },
      { status: err.status, headers },
    );
  }
  if (err instanceof ZodError) {
    return NextResponse.json(
      {
        error: {
          code: "INVALID_INPUT",
          message: "Some fields are invalid.",
          details: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
        },
      },
      { status: 400 },
    );
  }
  logger.error("unhandled_error", { error: err instanceof Error ? err.message : String(err) });
  return NextResponse.json(
    { error: { code: "INTERNAL", message: "Something went wrong. Please try again." } },
    { status: 500 },
  );
}

/** Wrap a route handler so thrown errors become consistent JSON responses. */
export function handler<A extends unknown[]>(fn: (...args: A) => Promise<Response>) {
  return async (...args: A): Promise<Response> => {
    try {
      return await fn(...args);
    } catch (err) {
      return toErrorResponse(err);
    }
  };
}
