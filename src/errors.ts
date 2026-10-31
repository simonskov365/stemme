export class AppError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}
export function safeError(e: unknown): AppError {
  if (e instanceof AppError) return e;
  return new AppError(
    "INTERNAL_ERROR",
    "The operation failed. See service status or retry with a new request identifier.",
    500,
  );
}
