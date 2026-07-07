import { ratePasswordStrength } from "@filen/utils"

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/**
 * Validates an email address against a simple, trimmed regex. Pure helper shared
 * by the login and register screens.
 */
export function isValidEmail(email: string): boolean {
	return EMAIL_REGEX.test(email.trim())
}

/**
 * Registration's minimum password strength gate — the "weak" tier is rejected, "normal"
 * and above pass. Pure helper shared by the register screen's submit gate and its tests.
 */
export function isPasswordStrongEnough(passwordStrength: ReturnType<typeof ratePasswordStrength> | null): boolean {
	return passwordStrength !== null && passwordStrength.strength !== "weak"
}
