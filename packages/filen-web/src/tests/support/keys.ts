// A test keydown with the physical key a US keyboard types `init.key` with, as a real one carries: every shortcut
// matches by KeyboardEvent.code (@filen/shared/keymap). A code given wins.
const PUNCTUATION: Readonly<Record<string, string>> = {
	" ": "Space",
	"/": "Slash",
	"?": "Slash",
	"\\": "Backslash",
	"[": "BracketLeft",
	"]": "BracketRight",
	"=": "Equal",
	"+": "Equal",
	"-": "Minus",
	",": "Comma",
	".": "Period"
}

export function usCode(key: string): string {
	if (/^[a-z]$/iu.test(key)) return `Key${key.toUpperCase()}`
	if (/^[0-9]$/u.test(key)) return `Digit${key}`

	return PUNCTUATION[key] ?? key
}

export function withCode<T extends { key?: string; code?: string }>(init: T): T & { code: string } {
	return { ...init, code: init.code ?? usCode(init.key ?? "") }
}
