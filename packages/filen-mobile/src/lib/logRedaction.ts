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
// a substring, so apiKey / masterKeys / privateKey / authInfo / twoFactorCode / sessionToken / … all
// match. Deliberately aggressive on names: over-redacting a field literally named like a secret is
// cheap, leaking one is catastrophic. `auth_?info` is the StringifiedClient field that holds the
// V1/V2 master keys (or V3 DEK) — the single worst secret in the app. `key$` / `\bkey\b` matches the
// per-file encryption key on DecryptedFileMeta.key and the master keys. NOTE: `key$` ALSO matches
// TanStack's `queryKey`, so a `queryKey` field is redacted too — an accepted cost (we don't carve
// out exceptions; secrets-first).
const SECRET_KEY_RE =
	/pass|secret|token|api_?key|master_?keys?|private_?key|public_?key|metadata_?key|auth_?info|key$|\bkey\b|\bdek\b|\bkek\b|derived|recovery|two_?factor|2fa|\botp\b|mnemonic|seed|credential|authoriz|bearer|stringifiedclient/i

// String VALUES that are obviously serialized secret material even without a telltale key name:
// a stringified SDK client / auth blob, a PEM block, or a long high-entropy blob (joined master
// keys, ciphertext). `auth_?info` catches a stringified StringifiedClient JSON.
const SECRET_VALUE_MARKER_RE = /master_?keys?|private_?key|auth_?info|stringifiedclient|-----BEGIN/i
const LONG_BLOB_RE = /[A-Za-z0-9+/=_-]{128,}/
// A standalone fixed-length symmetric key/DEK: 64+ hex chars (V2/V3 keys are 64 hex). Anchored to
// the WHOLE string so it can't match a path/sentence/UUID (those carry separators/spaces). A 64-hex
// content hash also matches and gets redacted — an accepted, harmless loss (a hash isn't the signal).
const HEX_KEY_RE = /^[0-9a-f]{64,}$/i

function redactString(value: string): string {
	if (SECRET_VALUE_MARKER_RE.test(value) || LONG_BLOB_RE.test(value) || HEX_KEY_RE.test(value)) {
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

	// BigInt must be stringified — JSON.stringify THROWS on a raw bigint, and filen uses bigint
	// pervasively (DriveItem.size etc.), so passing it through would collapse the whole log line to
	// the "[unserializable]" fallback. Tag with a trailing "n" so it's recognizable in the log.
	if (type === "bigint") {
		return `${(value as bigint).toString()}n`
	}

	if (type === "number" || type === "boolean") {
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

	// Non-plain objects (constructor !== Object) can be binary views or UniFFI tagged unions —
	// both of which bare JSON mangles: a typed array becomes a giant {"0":..,"1":..} index-object,
	// and a UniFFI enum's type name lives on a global symbol that Object.keys never sees. Handle
	// them explicitly. (Plain literals/JSON skip this and go straight to the key-walk.)
	if (obj.constructor !== Object) {
		// Binary: summarize, never dump the bytes (log readability + size).
		if (ArrayBuffer.isView(value)) {
			const view = value as { constructor: { name: string }; byteLength: number }

			return `[${view.constructor.name} byteLength=${view.byteLength}]`
		}

		if (value instanceof ArrayBuffer) {
			return `[ArrayBuffer byteLength=${value.byteLength}]`
		}

		// UniFFI tagged union (uniffi-bindgen-react-native): the type name is symbol-keyed; the
		// variant `.tag` + `.inner` are regular props. Capture the discriminant explicitly.
		const typeName = (value as Record<symbol, unknown>)[Symbol.for("typeName")]

		if (typeof typeName === "string") {
			const enumValue = value as { tag?: unknown; inner?: unknown }
			const ueOut: Record<string, unknown> = {
				__type: typeName,
				tag: enumValue.tag
			}

			if (enumValue.inner !== undefined) {
				ueOut["inner"] = redactValue(enumValue.inner, depth + 1, seen)
			}

			return ueOut
		}
	}

	const source = obj as Record<string, unknown>
	const out: Record<string, unknown> = {}

	// Per-key guard: a property getter that throws when read must not collapse the whole entry to
	// the "[unserializable]" fallback — isolate it to "[unreadable]" and keep the rest.
	for (const key of Object.keys(source)) {
		if (SECRET_KEY_RE.test(key)) {
			out[key] = REDACTED

			continue
		}

		try {
			out[key] = redactValue(source[key], depth + 1, seen)
		} catch {
			out[key] = "[unreadable]"
		}
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
