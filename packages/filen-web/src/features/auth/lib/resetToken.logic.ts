// The password-reset email links to `/reset#<token>` (the previous web app's `#/reset/<token>` is rewritten to it by
// lib/legacyUrl.logic.ts). The token rides the fragment so no request carries it; the reset page reads it from there
// once and takes it out of the address bar. Never log it.
const RESET_TOKEN_RE = /^[\x21\x22\x24-\x2e\x30-\x3e\x40-\x5b\x5d-\x7e]{1,1024}$/

// The token in a `location.hash` ("#<token>"), or null when there is none or it is not a token's shape.
export function resetTokenFromHash(hash: string): string | null {
	const token = hash.startsWith("#") ? hash.slice(1) : hash

	return RESET_TOKEN_RE.test(token) ? token : null
}
