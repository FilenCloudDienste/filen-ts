// Masks what could be a credential in log text before it is written or exported. Nothing logs secrets by design (main
// logs error codes, never payloads); this is the backstop for third-party messages and the page's own log.
const MASK = "[redacted]"

const RULES: readonly [RegExp, string][] = [
	// Credentials inside URLs: scheme://user:password@host.
	[/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, `$1${MASK}@`],
	// Authorization header values.
	[/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/g, `$1 ${MASK}`],
	// Command-line flags carrying secrets, as rclone takes them: --webdav-pass x, --password=x, --s3-secret-access-key x.
	[/(--[a-z0-9-]*(?:pass|password|secret|token|key|credential)[a-z0-9-]*)(=|\s+)(?!-)\S+/gi, `$1$2${MASK}`],
	// Secret-named fields in JSON or key=value text. The session's own fields are among them.
	[
		/(["']?\b(?:api[_-]?key|apikey|password|passwd|secret|token|access[_-]?token|refresh[_-]?token|auth[_-]?info|master[_-]?keys?|private[_-]?key|authorization|cookie)\b["']?\s*[:=]\s*)("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s,;}&]+)/gi,
		`$1${MASK}`
	],
	// JWTs.
	[/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, MASK],
	// Long opaque runs mixing letters and digits: keys, tokens, hashes. Paths and words do not mix like this.
	[/(?<![A-Za-z0-9+=_-])(?=[A-Za-z0-9+=_-]*\d)(?=[A-Za-z0-9+=_-]*[A-Za-z])[A-Za-z0-9+=_-]{40,}/g, MASK]
]

export function redact(text: string): string {
	let result = text

	for (const [pattern, replacement] of RULES) {
		result = result.replace(pattern, replacement)
	}

	return result
}
