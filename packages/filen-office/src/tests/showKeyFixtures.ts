// The physical key a US layout types `key` on: the show matches keys by code.
export function codeOf(key: string): string {
	if (/^[a-z]$/iu.test(key)) return `Key${key.toUpperCase()}`
	if (/^[0-9]$/u.test(key)) return `Digit${key}`

	return ({ " ": "Space", ".": "Period", ",": "Comma" } as Readonly<Record<string, string>>)[key] ?? key
}
