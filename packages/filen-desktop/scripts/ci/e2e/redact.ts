// Masks known secret values (credentials, the account's email) in text the harness logs or attaches. Longest first, so a
// value containing another is masked whole.
export function redactor(secrets: readonly string[]): (text: string) => string {
	const values = [...new Set(secrets.filter(secret => secret.length >= 4))].sort((a, b) => b.length - a.length)

	return text => values.reduce((masked, secret) => masked.split(secret).join("<redacted>"), text)
}
