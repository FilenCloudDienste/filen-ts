import { nameCollisionKey } from "./driveItem"
import { extensionStart } from "./fileExtensions"

export type LocalPlatform = "darwin" | "win32" | "linux"

const MAX_NAME_BYTES = 255
// A capped name keeps its extension only while this much of the base survives; a longer "extension" is part of the name.
const MIN_BASE_BYTES = 16
const REPLACEMENT = "_"

// Device names win32 resolves before the filesystem sees them, whatever follows the first dot. Upper case.
const WIN32_RESERVED_NAMES: ReadonlySet<string> = new Set([
	"CON",
	"PRN",
	"AUX",
	"NUL",
	"CONIN$",
	"CONOUT$",
	"COM0",
	"COM1",
	"COM2",
	"COM3",
	"COM4",
	"COM5",
	"COM6",
	"COM7",
	"COM8",
	"COM9",
	"COM¹",
	"COM²",
	"COM³",
	"LPT0",
	"LPT1",
	"LPT2",
	"LPT3",
	"LPT4",
	"LPT5",
	"LPT6",
	"LPT7",
	"LPT8",
	"LPT9",
	"LPT¹",
	"LPT²",
	"LPT³"
])

const WIN32_RESERVED_MAX_LENGTH = 7

// Separators, NUL and the other controls on every platform; win32 also rejects `: * ? " < > |`.
function isUnsafeCharCode(code: number, win32: boolean): boolean {
	if (code < 0x20 || code === 0x7f || code === 47 || code === 92) {
		return true
	}

	return win32 && (code === 58 || code === 42 || code === 63 || code === 34 || code === 60 || code === 62 || code === 124)
}

function replaceUnsafe(name: string, win32: boolean): string {
	let result = ""
	let kept = 0

	for (let i = 0; i < name.length; i++) {
		if (isUnsafeCharCode(name.charCodeAt(i), win32)) {
			result += name.slice(kept, i) + REPLACEMENT
			kept = i + 1
		}
	}

	return kept === 0 ? name : result + name.slice(kept)
}

// win32 drops trailing dots and spaces, and a device name before the first dot (trailing spaces ignored) opens the device:
// trim the former, append "_" to the latter's stem.
function win32Name(name: string): string {
	let end = name.length

	while (end > 0 && (name.charCodeAt(end - 1) === 46 || name.charCodeAt(end - 1) === 32)) {
		end--
	}

	const trimmed = end === name.length ? name : name.slice(0, end)
	const dot = trimmed.indexOf(".")
	let stemEnd = dot === -1 ? trimmed.length : dot

	while (stemEnd > 0 && trimmed.charCodeAt(stemEnd - 1) === 32) {
		stemEnd--
	}

	if (stemEnd === 0 || stemEnd > WIN32_RESERVED_MAX_LENGTH || !WIN32_RESERVED_NAMES.has(trimmed.slice(0, stemEnd).toUpperCase())) {
		return trimmed
	}

	return trimmed.slice(0, stemEnd) + REPLACEMENT + trimmed.slice(stemEnd)
}

// UTF-8 length without encoding; a lone surrogate counts as the 3-byte U+FFFD it encodes to.
function utf8Length(value: string): number {
	let length = 0

	for (let i = 0; i < value.length; i++) {
		const code = value.charCodeAt(i)

		if (code < 0x80) {
			length += 1
		} else if (code < 0x800) {
			length += 2
		} else if (code >= 0xd800 && code <= 0xdbff && i + 1 < value.length && (value.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
			length += 4
			i++
		} else {
			length += 3
		}
	}

	return length
}

// The longest prefix of `value` within `maxBytes` UTF-8 bytes, never splitting a surrogate pair.
function utf8Prefix(value: string, maxBytes: number): string {
	let length = 0

	for (let i = 0; i < value.length; i++) {
		const code = value.charCodeAt(i)
		const pair = code >= 0xd800 && code <= 0xdbff && i + 1 < value.length && (value.charCodeAt(i + 1) & 0xfc00) === 0xdc00
		const size = code < 0x80 ? 1 : code < 0x800 ? 2 : pair ? 4 : 3

		if (length + size > maxBytes) {
			return value.slice(0, i)
		}

		length += size

		if (pair) {
			i++
		}
	}

	return value
}

// `name` with `insert` before its extension (`extension` is extensionStart's index or -1), the base cut so the whole stays
// within MAX_NAME_BYTES. An extension too long to keep is cut like the base.
function fitName(name: string, extension: number, insert: string): string {
	let base = name
	let tail = insert

	if (extension !== -1) {
		const kept = insert + name.slice(extension)

		if (utf8Length(kept) + MIN_BASE_BYTES <= MAX_NAME_BYTES) {
			base = name.slice(0, extension)
			tail = kept
		}
	}

	if (utf8Length(base) + utf8Length(tail) <= MAX_NAME_BYTES) {
		return base + tail
	}

	return utf8Prefix(base, MAX_NAME_BYTES - utf8Length(tail)) + tail
}

/**
 * One safe local path component for a remote name: NFC; separators, NUL, controls and (win32) `: * ? " < > |` become `_`;
 * on win32 trailing dots and spaces are trimmed and device names (CON, COM1.txt, "CON .txt", ...) get `_` after their stem.
 * Dotfiles stay dotfiles; the result is never "", "." or ".." and at most 255 UTF-8 bytes, keeping the extension.
 * Unlike sanitizeFileName, it keeps leading dots and inner whitespace: it preserves the remote name wherever the platform allows.
 */
export function localName(name: string, platform: LocalPlatform): string {
	const win32 = platform === "win32"
	let result = replaceUnsafe(name.normalize("NFC"), win32)

	if (win32) {
		result = win32Name(result)
	}

	if (utf8Length(result) > MAX_NAME_BYTES) {
		result = fitName(result, extensionStart(result), "")

		if (win32) {
			// Capping can end the name in a space or dot, or cut it back to a device stem.
			result = win32Name(result)

			if (utf8Length(result) > MAX_NAME_BYTES) {
				result = win32Name(fitName(result, extensionStart(result), ""))
			}
		}
	}

	if (result === "" || result === ".") {
		return REPLACEMENT
	}

	return result === ".." ? REPLACEMENT + REPLACEMENT : result
}

/**
 * The n-th keep-both name for a local `name` (n = 0 is the name itself): files "a (1).txt", "a.tar (1).gz"; directories,
 * extensionless names and dotfiles "dir (1)", ".env (1)". The base is cut so the result stays within 255 UTF-8 bytes.
 */
export function keepBothName(name: string, n: number, kind: "file" | "directory"): string {
	if (n === 0) {
		return name
	}

	return fitName(name, kind === "file" ? extensionStart(name) : -1, ` (${n})`)
}

// The key two local names collide on (APFS and NTFS are case-insensitive by default; APFS also normalization-insensitive).
export function localCollisionKey(name: string): string {
	return nameCollisionKey(name.normalize("NFC"))
}
