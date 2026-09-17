export function errMessage(e: unknown, fallback?: string): string {
  // Structural displayMessage read: coded API errors carry a localized
  // display message that wins over the raw English one. Deliberately no
  // type import — chassis sits below the modules that define the property
  // (documented fork of the qm upstream chassis).
  if (e && typeof e === "object" && typeof (e as { displayMessage?: unknown }).displayMessage === "string") {
    return (e as { displayMessage: string }).displayMessage;
  }
  return e instanceof Error ? e.message : (fallback ?? String(e));
}

export function swallow(context: string, e: unknown): void {
  console.warn(`[swallowed] ${context}: ${errMessage(e)}`);
}
