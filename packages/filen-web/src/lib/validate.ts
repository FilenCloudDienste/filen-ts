import type { ratePasswordStrength } from "@filen/utils"

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

// Mirrors filen-mobile's `isValidEmail` (same regex) — @filen/utils ships no email helper (verified:
// no "email" hit anywhere in its dist output), so this stays a small local helper shared by the
// login, register and reset forms rather than a one-off per screen.
export function isValidEmail(email: string): boolean {
	return EMAIL_REGEX.test(email.trim())
}

// Mirrors filen-mobile's `isPasswordStrongEnough` exactly: weak is the only blocked tier, null means
// no password typed yet. Both credential-creating forms (register, reset) gate their submit on this,
// so the minimum-strength policy lives in one place.
export function isPasswordStrongEnough(passwordStrength: ReturnType<typeof ratePasswordStrength> | null): boolean {
	return passwordStrength !== null && passwordStrength.strength !== "weak"
}
