const SECRET_ENV_NAME = /(?:secret|password|passwd|token|api[-_]?key|access[-_]?key|private[-_]?key|credential|authorization)/i
const MIN_SECRET_VALUE_LENGTH = 8
const MASK = '[redacted]'

export function createSecretValueMasker(env?: Record<string, string>): (text: string) => string {
  if (!env) return (text) => text
  const values = [
    ...new Set(
      Object.entries(env)
        .filter(([name, value]) => SECRET_ENV_NAME.test(name) && value.length >= MIN_SECRET_VALUE_LENGTH)
        .map(([, value]) => value),
    ),
  ]
  if (!values.length) return (text) => text
  return (text) => {
    let out = text
    for (const value of values) out = out.split(value).join(MASK)
    return out
  }
}
