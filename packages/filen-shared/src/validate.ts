import { type PasswordStrength } from "./misc"

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

// Shared by the login, register, reset and contact-request forms on both apps.
export function isValidEmail(email: string): boolean {
	return EMAIL_REGEX.test(email.trim())
}

// Weak is the only blocked tier, null means no password typed yet. Both credential-creating forms
// (register, reset) gate their submit on this, so the minimum-strength policy lives in one place.
export function isPasswordStrongEnough(passwordStrength: PasswordStrength | null): boolean {
	return passwordStrength !== null && passwordStrength !== "weak"
}

// The server's nickname rule, checked after it trims: 3-32 letters, digits, spaces, _ or -. Its
// leading/trailing-space lookarounds are moot on a trimmed value, so this stays lookbehind-free.
const NICKNAME_REGEX = /^[A-Za-z0-9 _-]{3,32}$/

// An empty nickname is valid: saving it clears the nickname.
export function isValidNickname(nickname: string): boolean {
	const trimmed = nickname.trim()

	return trimmed === "" || NICKNAME_REGEX.test(trimmed)
}

export { validate as validateUuid } from "uuid"
