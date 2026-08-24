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
