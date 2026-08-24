export const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

export const chunk = <T>(items: T[], size: number): T[][] => {
  if (items.length <= size) return items.length > 0 ? [items] : []
  const chunks: T[][] = []
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size))
  }
  return chunks
}

export const envInt = (name: string, fallback: number): number => {
  const parsed = parseInt(process.env[name] ?? '', 10)
  return Number.isFinite(parsed) ? parsed : fallback
}

export const log = (msg: string, ...rest: unknown[]) => {
  console.log(`[${new Date().toISOString()}] - ${msg}`, ...rest)
}

export const logError = (msg: string, ...rest: unknown[]) => {
  console.error(`[${new Date().toISOString()}] - ${msg}`, ...rest)
}

/**
 * Exponential backoff with equal jitter, capped at `ceilingMs`.
 *
 * The jitter matters as much as the backoff: both streams reconnect against
 * Bluesky-operated endpoints, so an upstream outage would otherwise have every
 * client retrying in lockstep at exactly the moment the endpoint comes back.
 */
export const backoffDelay = (
  attempt: number,
  baseMs: number,
  ceilingMs: number,
): number => {
  const exp = Math.min(baseMs * 2 ** Math.max(0, attempt - 1), ceilingMs)
  return Math.round(exp / 2 + Math.random() * (exp / 2))
}
