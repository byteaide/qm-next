export function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

export function swallow(context: string, e: unknown): void {
  console.warn(`[${context}]`, errMessage(e))
}

export function swallowAs<T>(context: string, fallback: T): (e: unknown) => T {
  return (e: unknown) => {
    swallow(context, e)
    return fallback
  }
}
