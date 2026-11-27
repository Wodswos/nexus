/** Transport failures are safe to retry for read-only checks, never for input delivery. */
export function transientRemoteError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '');
  return /kex_exchange_identification|connection reset|connection (?:timed out|closed)|broken pipe|network is unreachable|no route to host|econnreset|etimedout|SSH 请求超时|SSH 请求过多/i.test(message);
}
