/**
 * Skill name grammar, ported verbatim from qm's `skill-name.ts`.
 */
const SAFE_SKILL_NAME = /^[a-z0-9](?:[a-z0-9_.-]{0,126}[a-z0-9_-])?$/

export function isSafeSkillName(name: string): boolean {
  return SAFE_SKILL_NAME.test(name)
}

export function assertSafeSkillName(name: string): string {
  if (!isSafeSkillName(name)) {
    throw new Error(
      'skill name must be 1-128 lowercase ASCII letters, digits, dots, underscores, or hyphens; it must start with a lowercase letter or digit and cannot end with a dot',
    )
  }
  return name
}
