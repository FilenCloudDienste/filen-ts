const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/**
 * Validates an email address against a simple, trimmed regex. Pure helper shared
 * by the login and register screens.
 */
export function isValidEmail(email: string): boolean {
	return EMAIL_REGEX.test(email.trim())
}
