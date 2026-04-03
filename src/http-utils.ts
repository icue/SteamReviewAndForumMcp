const TRANSIENT_HTTP_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);
const DEFAULT_FETCH_MAX_ATTEMPTS = 4;
const DEFAULT_FETCH_BASE_RETRY_DELAY_MS = 500;
const DEFAULT_FETCH_MAX_RETRY_DELAY_MS = 4000;

function getPositiveIntegerEnv(name: string, fallback: number): number {
  const configuredValue = Number(process.env[name]);
  if (Number.isFinite(configuredValue) && configuredValue > 0) {
    return Math.floor(configuredValue);
  }

  return fallback;
}

function buildHttpError(label: string, response: Response): Error {
  return new Error(
    `${label}: ${response.status} ${response.statusText}`,
  );
}

function getRetryAfterMs(response: Response): number | null {
  const retryAfterHeader = response.headers.get("retry-after");
  if (!retryAfterHeader) {
    return null;
  }

  const retryAfterSeconds = Number(retryAfterHeader);
  if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0) {
    return retryAfterSeconds * 1000;
  }

  const retryAfterTimestamp = Date.parse(retryAfterHeader);
  if (Number.isFinite(retryAfterTimestamp)) {
    const delayMs = retryAfterTimestamp - Date.now();
    return delayMs > 0 ? delayMs : 0;
  }

  return null;
}

function getRetryDelayMs(attempt: number): number {
  const baseDelayMs = getPositiveIntegerEnv(
    "STEAM_FETCH_BASE_RETRY_DELAY_MS",
    DEFAULT_FETCH_BASE_RETRY_DELAY_MS,
  );
  const maxDelayMs = getPositiveIntegerEnv(
    "STEAM_FETCH_MAX_RETRY_DELAY_MS",
    DEFAULT_FETCH_MAX_RETRY_DELAY_MS,
  );
  const jitterMs = Math.floor(Math.random() * 100);
  const delayMs = baseDelayMs * 2 ** Math.max(0, attempt - 1) + jitterMs;
  return Math.min(delayMs, maxDelayMs);
}

export async function sleep(ms: number): Promise<void> {
  if (ms <= 0) {
    return;
  }

  await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function fetchWithRetry(
  input: URL | string,
  init: RequestInit,
  label: string,
): Promise<Response> {
  const maxAttempts = getPositiveIntegerEnv(
    "STEAM_FETCH_MAX_ATTEMPTS",
    DEFAULT_FETCH_MAX_ATTEMPTS,
  );

  let lastError: unknown = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await fetch(input, init);

      if (response.ok) {
        return response;
      }

      const responseError = buildHttpError(label, response);
      if (
        !TRANSIENT_HTTP_STATUSES.has(response.status) ||
        attempt === maxAttempts
      ) {
        throw responseError;
      }

      lastError = responseError;
      await sleep(getRetryAfterMs(response) ?? getRetryDelayMs(attempt));
    } catch (error) {
      lastError = error;
      if (attempt === maxAttempts) {
        throw error;
      }

      await sleep(getRetryDelayMs(attempt));
    }
  }

  throw lastError;
}
