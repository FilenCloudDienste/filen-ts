import { type ratePasswordStrength } from "./misc"

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

// Shared by the login, register, reset and contact-request forms on both apps.
export function isValidEmail(email: string): boolean {
	return EMAIL_REGEX.test(email.trim())
}

// Weak is the only blocked tier, null means no password typed yet. Both credential-creating forms
// (register, reset) gate their submit on this, so the minimum-strength policy lives in one place.
export function isPasswordStrongEnough(passwordStrength: ReturnType<typeof ratePasswordStrength> | null): boolean {
	return passwordStrength !== null && passwordStrength.strength !== "weak"
}
