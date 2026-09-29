// otpauth URI for the enable-2FA QR code. "Issuer:account" is the standard label convention most
// authenticator apps parse into a two-line list entry (issuer above, account name below); both
// segments are percent-encoded (not just the secret) since an email address can contain characters
// an otpauth URI must escape (`@`, `+`, …). The bare secret alone is NOT scannable by most
// authenticator apps' camera scanners — they expect an `otpauth://` URI, not a raw string — this
// follows the old web app's own precedent for this exact card.
export function buildOtpauthUri(email: string, secret: string): string {
	return `otpauth://totp/${encodeURIComponent(`Filen:${email}`)}?secret=${encodeURIComponent(secret)}`
}
