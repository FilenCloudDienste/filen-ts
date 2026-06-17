// Conservative, SECRETS-ONLY redaction for the diagnostic logger.
//
// Product decision (jan): logs intentionally KEEP decrypted file/dir names, paths, search
// queries and other user data — that is exactly what makes bugs findable, and the user is warned
// at export and shares the logs voluntarily. What must NEVER reach an exported log is actual
// secret material: a leaked master key or apiKey hands over the user's entire encrypted account.
// So this module strips ONLY those, and leaves everything else intact.
//
// Runs at flush time (off the hot path), so it can afford to walk the value graph.

const REDACTED = "[redacted]"
const MAX_STRING_LENGTH = 2000
const MAX_DEPTH = 8

// Object KEY names whose VALUES are auth credentials or crypto keys. Matched case-insensitively as
// a substring, so apiKey / masterKeys / privateKey / twoFactorCode / sessionToken / … all match.
// Deliberately aggressive on names: over-redacting a field literally named like a secret is cheap,
// leaking one is catastrophic. `\bkey\b` / `…Key` matches the per-file encryption key carried on
// DecryptedFileMeta.key and the master keys; TanStack's `queryKey` is logged as a scalar/array
// under its own name, never as a `key` field, so it survives.
const SECRET_KEY_RE =
	/pass|secret|token|api_?key|master_?keys?|private_?key|public_?key|metadata_?key|key$|\bkey\b|\bdek\b|two_?factor|2fa|\botp\b|mnemonic|seed|credential|authoriz|bearer|stringifiedclient/i

// String VALUES that are obviously serialized secret material even without a telltale key name:
// a stringified SDK client, a PEM block, or a very long high-entropy blob (key/ciphertext).
const SECRET_VALUE_MARKER_RE = /master_?keys?|private_?key|stringifiedclient|-----BEGIN/i
const LONG_BLOB_RE = /[A-Za-z0-9+/=_-]{128,}/

function redactString(value: string): string {
	if (SECRET_VALUE_MARKER_RE.test(value) || LONG_BLOB_RE.test(value)) {
		return REDACTED
	}

	if (value.length > MAX_STRING_LENGTH) {
		return `${value.slice(0, MAX_STRING_LENGTH)}…(+${value.length - MAX_STRING_LENGTH} chars)`
	}

	return value
}

function redactValue(value: unknown, depth: number, seen: WeakSet<object>): unknown {
	if (value === null || value === undefined) {
		return value
	}

	const type = typeof value

	if (type === "string") {
		return redactString(value as string)
	}

	if (type === "number" || type === "boolean" || type === "bigint") {
		return value
	}

	if (type === "function") {
		return "[function]"
	}

	if (type !== "object") {
		return String(value)
	}

	if (depth >= MAX_DEPTH) {
		return "[depth]"
	}

	const obj = value as object

	if (seen.has(obj)) {
		return "[circular]"
	}

	seen.add(obj)

	// Keep an Error's message + stack — stacks are code paths, not user data, and are the single
	// highest-value diagnostic. The message still runs through the string scrub.
	if (value instanceof Error) {
		return {
			name: value.name,
			message: redactString(value.message),
			stack: value.stack
		}
	}

	if (Array.isArray(value)) {
		const out = new Array<unknown>(value.length)

		for (let i = 0; i < value.length; i++) {
			out[i] = redactValue(value[i], depth + 1, seen)
		}

		return out
	}

	const source = obj as Record<string, unknown>
	const out: Record<string, unknown> = {}

	for (const key of Object.keys(source)) {
		out[key] = SECRET_KEY_RE.test(key) ? REDACTED : redactValue(source[key], depth + 1, seen)
	}

	return out
}

/**
 * Returns a redacted clone of `value` safe to write to an exportable diagnostic log: secret
 * credentials and crypto keys are masked, everything else (names, paths, ids, content) is kept.
 */
export function redact(value: unknown): unknown {
	return redactValue(value, 0, new WeakSet<object>())
}
