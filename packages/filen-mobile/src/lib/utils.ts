import { type ChatParticipant, type NoteParticipant, type Contact, type ContactRequestIn, type ContactRequestOut } from "@filen/sdk-rs"
import mimeTypes from "mime-types"

export function contactDisplayName(contact: Contact | NoteParticipant | ChatParticipant | ContactRequestIn | ContactRequestOut): string {
	return contact.nickName && contact.nickName.length > 0 ? contact.nickName : contact.email
}

/**
 * Make `filename` safe to write as a single path component on iOS (APFS) and
 * Android (ext4/F2FS/FAT32/exFAT): NFC-normalizes, strips control/zero-width
 * characters, replaces the cross-platform-illegal set (`/ : < > " \ | ? *`) and
 * whitespace runs with `replacement` (default `"_"`), removes leading/trailing
 * dots and spaces, drops a leading dot to avoid hidden files, and truncates to
 * 255 UTF-8 bytes while preserving a trailing extension.
 *
 * Degenerate input — empty, all dots/spaces, `"."`, `".."`, or anything that
 * reduces to empty after sanitization — returns the literal `"file"`; it never
 * returns an empty string.
 *
 * Note: this does NOT percent-decode and does NOT strip `%`. A returned name may
 * still contain a bare `%`, so callers must not pass the result to
 * `decodeURIComponent` without their own guard.
 */
export function sanitizeFileName(filename: string, replacement: string = "_"): string {
	// Normalize to UTF-8 NFC form (canonical decomposition followed by canonical composition)
	let sanitizedFilename = filename.normalize("NFC")

	// Remove or replace problematic Unicode characters
	// Remove zero-width characters and other invisible/control characters
	// eslint-disable-next-line no-control-regex
	sanitizedFilename = sanitizedFilename.replace(/[\u200B-\u200D\uFEFF\u00AD\u0000-\u001F\u007F-\u009F]/g, "")

	// iOS specific: Replace characters that cause issues in APFS
	// APFS doesn't allow: / (directory separator) and : (legacy HFS+ path separator)
	// Also problematic: null bytes
	sanitizedFilename = sanitizedFilename.replace(/[/:]/g, replacement)

	// Android specific: Replace characters illegal in FAT32, exFAT, and ext4
	// FAT32/exFAT don't allow: < > : " / \ | ? *
	// Note: Android 12+ uses F2FS/ext4 for internal storage but may use FAT32/exFAT for external
	sanitizedFilename = sanitizedFilename.replace(/[<>:"\\|?*]/g, replacement)

	// Remove leading/trailing dots and spaces (problematic on both platforms)
	// iOS: Leading dots create hidden files
	// Android: Trailing dots/spaces can cause issues
	sanitizedFilename = sanitizedFilename.replace(/^[. ]+|[. ]+$/g, "")

	// Prevent hidden files (leading dot after sanitization)
	if (sanitizedFilename.startsWith(".")) {
		sanitizedFilename = sanitizedFilename.slice(1) || "file"
	}

	// Optionally normalize whitespace (you may want to keep this configurable)
	sanitizedFilename = sanitizedFilename.replace(/\s+/g, replacement)

	// iOS: APFS supports up to 255 UTF-8 bytes per filename component
	// Android: ext4 supports 255 bytes, F2FS supports 255 bytes
	// Both measure in bytes, not characters
	const maxByteLength = 255
	const byteLength = new TextEncoder().encode(sanitizedFilename).length

	// Trim filename preserving extension if possible
	if (byteLength > maxByteLength) {
		const extensionMatch = sanitizedFilename.match(/(\.[^.]{1,10})$/)
		const extension = extensionMatch ? extensionMatch[1] : ""
		const extensionBytes = new TextEncoder().encode(extension).length
		const maxNameBytes = maxByteLength - extensionBytes

		let baseName = extension ? sanitizedFilename.slice(0, -extension.length) : sanitizedFilename
		let baseBytes = new TextEncoder().encode(baseName).length

		while (baseBytes > maxNameBytes && baseName.length > 0) {
			baseName = baseName.slice(0, -1)
			baseBytes = new TextEncoder().encode(baseName).length
		}

		sanitizedFilename = baseName + extension
	}

	// Final validation
	if (!sanitizedFilename || sanitizedFilename === "." || sanitizedFilename === "..") {
		return "file"
	}

	return sanitizedFilename
}

export { listLocalDirectoryRecursive } from "@/lib/fsUtils"

export function normalizeModificationTimestampForComparison(timestamp: number): number {
	return Math.floor(timestamp / 1000)
}

export function resolveMimeType({ mime, name }: { mime: string | null | undefined; name: string }): string {
	return mime || mimeTypes.lookup(name) || "application/octet-stream"
}

export type BigIntToNumber<T> = T extends bigint
	? number
	: T extends Date
		? Date
		: T extends (infer U)[]
			? BigIntToNumber<U>[]
			: T extends object
				? {
						[K in keyof T]: BigIntToNumber<T[K]>
					}
				: T

/**
 * Generic deep converter that walks a value and replaces every `bigint` with its
 * `Number` equivalent, preserving `Date` instances and array/object structure.
 * Used to make SDK responses JSON-serializable.
 */
export function convertBigInts<T>(value: T): BigIntToNumber<T> {
	if (typeof value === "bigint") {
		return Number(value) as BigIntToNumber<T>
	}

	if (value === null || value === undefined) {
		return value as BigIntToNumber<T>
	}

	if (Array.isArray(value)) {
		return value.map(convertBigInts) as BigIntToNumber<T>
	}

	// Preserve Date (and other built-ins you don't want to walk into)
	if (value instanceof Date) {
		return value as BigIntToNumber<T>
	}

	if (typeof value === "object") {
		const out: Record<string, unknown> = {}

		for (const key of Object.keys(value as object)) {
			out[key] = convertBigInts((value as Record<string, unknown>)[key])
		}

		return out as BigIntToNumber<T>
	}

	return value as BigIntToNumber<T>
}
