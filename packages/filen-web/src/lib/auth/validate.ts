const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

// Mirrors filen-mobile's `isValidEmail` (same regex) — @filen/utils ships no email helper (verified:
// no "email" hit anywhere in its dist output), so this stays a small local helper shared by the
// login, register and reset forms rather than a one-off per screen.
export function isValidEmail(email: string): boolean {
	return EMAIL_REGEX.test(email.trim())
}
