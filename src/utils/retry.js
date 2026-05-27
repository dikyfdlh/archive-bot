const DEFAULT_RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const DEFAULT_RETRYABLE_CODES = new Set([
  "ETIMEDOUT",
  "ECONNRESET",
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT"
]);

export async function withRetry(operation, options = {}) {
  const attempts = options.attempts ?? 3;
  const baseDelayMs = options.baseDelayMs ?? 600;
  const label = options.label || "operation";
  const onRetry = options.onRetry;

  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation(attempt);
    } catch (error) {
      lastError = error;

      if (attempt === attempts || !isRetryable(error)) {
        throw error;
      }

      const delay = baseDelayMs * 3 ** (attempt - 1) + Math.floor(Math.random() * 200);
      onRetry?.({ attempt, attempts, delay, label, error });
      await sleep(delay);
    }
  }

  throw lastError;
}

export function isRetryable(error) {
  if (!error) return false;
  if (error.retryable === true) return true;
  if (error.statusCode && DEFAULT_RETRYABLE_STATUS.has(error.statusCode)) return true;
  if (error.code && DEFAULT_RETRYABLE_CODES.has(error.code)) return true;
  if (error.cause?.code && DEFAULT_RETRYABLE_CODES.has(error.cause.code)) return true;
  return false;
}

export function annotateHttpError(error, response) {
  if (response && typeof response.status === "number") {
    error.statusCode = response.status;
  }
  return error;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
