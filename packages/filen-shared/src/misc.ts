import { utf8Length, utf8Prefix } from "./utf8"

export function parseNumbersFromString(string: string): number {
	let result = 0
	let digitCount = 0

	for (let i = 0; i < string.length && digitCount < 16; i++) {
		const code = string.charCodeAt(i)

		if (code >= 48 && code <= 57) {
			result = result * 10 + (code - 48)

			digitCount++
		}
	}

	return result
}

// "#rrggbb", any case
export function isValidHexColor(value: string): boolean {
	if (value.length !== 7 || value.charCodeAt(0) !== 35) {
		return false
	}

	for (let i = 1; i < 7; i++) {
		const code = value.charCodeAt(i)

		if (!((code >= 48 && code <= 57) || (code >= 65 && code <= 70) || (code >= 97 && code <= 102))) {
			return false
		}
	}

	return true
}

// C0 and C1 controls, DEL, soft hyphen, zero-width space/joiners and the BOM
function isInvisibleCharCode(code: number): boolean {
	return code <= 0x1f || (code >= 0x7f && code <= 0x9f) || code === 0xad || (code >= 0x200b && code <= 0x200d) || code === 0xfeff
}

// A scan rather than a regex: a control-character class trips `no-control-regex`.
function stripInvisibleChars(value: string): string {
	let result = ""
	let kept = 0

	for (let i = 0; i < value.length; i++) {
		if (isInvisibleCharCode(value.charCodeAt(i))) {
			result += value.slice(kept, i)
			kept = i + 1
		}
	}

	return kept === 0 ? value : result + value.slice(kept)
}

// APFS separators, then the FAT32/exFAT illegal set
const APFS_ILLEGAL_CHARS_RE = /[/:]/g
const FAT_ILLEGAL_CHARS_RE = /[<>:"\\|?*]/g
const LEADING_TRAILING_DOTS_SPACES_RE = /^[. ]+|[. ]+$/g
const WHITESPACE_RUN_RE = /\s+/g
const TRUNCATION_EXTENSION_RE = /(\.[^.]{1,10})$/
const FILE_NAME_REPLACEMENT = "_"
const MAX_FILE_NAME_BYTES = 255

/**
 * Make `filename` safe to write as a single path component on APFS, ext4, F2FS, FAT32 and exFAT:
 * NFC-normalizes, strips control/zero-width characters, replaces the cross-platform-illegal set
 * (`/ : < > " \ | ? *`) and whitespace runs with `_`, removes leading/trailing dots and
 * spaces (a leading dot would hide the file), and truncates to 255 UTF-8 bytes while preserving a
 * trailing extension.
 *
 * Degenerate input (empty, all dots/spaces, `"."`, `".."`, or anything that sanitizes to empty)
 * returns `"file"`, never an empty string.
 *
 * Does NOT percent-decode or strip `%`, so the result must not reach `decodeURIComponent` unguarded.
 */
export function sanitizeFileName(filename: string): string {
	let sanitizedFilename = stripInvisibleChars(filename.normalize("NFC"))

	sanitizedFilename = sanitizedFilename.replace(APFS_ILLEGAL_CHARS_RE, FILE_NAME_REPLACEMENT)
	sanitizedFilename = sanitizedFilename.replace(FAT_ILLEGAL_CHARS_RE, FILE_NAME_REPLACEMENT)
	sanitizedFilename = sanitizedFilename.replace(LEADING_TRAILING_DOTS_SPACES_RE, "")

	if (sanitizedFilename.startsWith(".")) {
		sanitizedFilename = sanitizedFilename.slice(1) || "file"
	}

	sanitizedFilename = sanitizedFilename.replace(WHITESPACE_RUN_RE, FILE_NAME_REPLACEMENT)

	// Filesystem limits count bytes, not characters
	if (utf8Length(sanitizedFilename) > MAX_FILE_NAME_BYTES) {
		const extension = sanitizedFilename.match(TRUNCATION_EXTENSION_RE)?.[1] ?? ""
		const baseName = extension ? sanitizedFilename.slice(0, -extension.length) : sanitizedFilename

		sanitizedFilename = utf8Prefix(baseName, MAX_FILE_NAME_BYTES - utf8Length(extension)) + extension
	}

	if (!sanitizedFilename || sanitizedFilename === "." || sanitizedFilename === "..") {
		return "file"
	}

	return sanitizedFilename
}

/**
 * Index of the last occurrence of `targetString` at or before `givenIndex`, or -1.
 *
 * Keep the slice form: `sourceString.lastIndexOf(targetString, givenIndex)` is NOT equivalent for
 * multi-character needles — that overload bounds where the match STARTS, not where it ends.
 *
 * This previously fell back to a loop that re-sliced `sourceString` for every offset down to 0 when the
 * search above missed — quadratic in `givenIndex`, on the per-keystroke chat-autocomplete path. The
 * loop was also dead: every slice it inspected was a substring of the one already searched, and a
 * string that does not contain the needle has no substring that does, so it could only return -1.
 */
export function findClosestIndexString(sourceString: string, targetString: string, givenIndex: number): number {
	return sourceString.slice(0, givenIndex + 1).lastIndexOf(targetString)
}

// Unicode classes, so a password in any script is rated by what it holds, not only its ASCII letters.
// Every class the former ASCII rule counted is a subset of one of these, so the rating only ever rises.
const HAS_UPPERCASE_RE = /[\p{Lu}\p{Lt}]/u
const HAS_LOWERCASE_RE = /\p{Ll}/u
// Letters of scripts without case (CJK, Arabic, Hebrew, ...) count as a class of their own.
const HAS_CASELESS_RE = /[\p{Lo}\p{Lm}]/u
const HAS_DIGIT_RE = /\p{Nd}/u
const HAS_SPECIAL_CHARS_RE = /[^\p{L}\p{Nd}]/u

// Below this length a password is always "weak".
export const PASSWORD_MIN_LENGTH = 10

// At this length a password rates at least "normal" whatever it holds.
export const PASSWORD_LONG_LENGTH = 20

export type PasswordStrength = "weak" | "normal" | "strong" | "best"

export function ratePasswordStrength(password: string): PasswordStrength {
	const length = password.length

	if (length < PASSWORD_MIN_LENGTH) {
		return "weak"
	}

	const classes =
		Number(HAS_UPPERCASE_RE.test(password)) +
		Number(HAS_LOWERCASE_RE.test(password)) +
		Number(HAS_CASELESS_RE.test(password)) +
		Number(HAS_DIGIT_RE.test(password)) +
		Number(HAS_SPECIAL_CHARS_RE.test(password))

	if (classes >= 3) {
		return length >= 16 ? "best" : "strong"
	}

	if (classes === 2 || length >= PASSWORD_LONG_LENGTH) {
		return "normal"
	}

	return "weak"
}

export function sortParams<T extends Record<string, unknown>>(params: T): T {
	const keys = Object.keys(params).sort()
	const len = keys.length
	const result = {} as T

	for (let i = 0; i < len; i++) {
		const key = keys[i] as keyof T

		result[key] = params[key]
	}

	return result
}

export function createExecutableTimeout(callback: () => void, delay?: number) {
	const timeoutId = setTimeout(callback, delay)
	// Clearing a fired or already-cleared timer is a no-op
	const cancel = () => clearTimeout(timeoutId)

	return {
		execute: () => {
			cancel()
			callback()
		},
		cancel
	}
}

function isAsciiDigit(code: number): boolean {
	return code >= 48 && code <= 57
}

// Combining marks (Combining Diacritical Marks and their supplements, extended and for symbols, half marks).
function isCombiningMark(code: number): boolean {
	return (
		(code >= 0x0300 && code <= 0x036f) ||
		(code >= 0x1ab0 && code <= 0x1aff) ||
		(code >= 0x1dc0 && code <= 0x1dff) ||
		(code >= 0x20d0 && code <= 0x20ff) ||
		(code >= 0xfe20 && code <= 0xfe2f)
	)
}

// Letters with a stroke or ligatures that have no canonical decomposition, placed at the letter they are read as.
function strokeLetterBase(code: number): number | undefined {
	switch (code) {
		case 0xdf: // ß
			return 115

		case 0xe6: // æ
			return 97

		case 0xf8: // ø
		case 0x153: // œ
			return 111

		case 0x111: // đ
			return 100

		case 0x127: // ħ
			return 104

		case 0x131: // ı
			return 105

		case 0x142: // ł
			return 108

		case 0x167: // ŧ
			return 116

		default:
			return undefined
	}
}

// Code unit -> primary weight for the units below U+2000 that were already looked up. Derived from Unicode data only,
// never from a name, so it holds nothing to clear on logout, and it stays under the 8192 units it can hold.
const textUnitWeights = new Map<number, number>()

function decomposedWeight(code: number): number {
	const stroke = strokeLetterBase(code)

	if (stroke !== undefined) {
		return stroke
	}

	const decomposed = String.fromCharCode(code).normalize("NFD")
	const length = decomposed.length

	if (length < 2) {
		return code
	}

	for (let i = 1; i < length; i++) {
		if (!isCombiningMark(decomposed.charCodeAt(i))) {
			return code
		}
	}

	const base = decomposed.charCodeAt(0)

	return base >= 65 && base <= 90 ? base + 32 : base
}

/**
 * The primary weight of one code unit, or -1 for a combining mark, which carries none. An ASCII unit weighs its code
 * unit; a letter that decomposes into a base letter and marks (é, Ä, ő, ё, ά) weighs its base letter, lowercased;
 * every other unit weighs its own code unit, after all of ASCII.
 */
function textUnitWeight(code: number): number {
	if (code < 128) {
		return code
	}

	if (isCombiningMark(code)) {
		return -1
	}

	// Scripts past U+2000 (CJK, Hangul, symbols, surrogates) have no base letter to place them at.
	if (code >= 0x2000) {
		return code
	}

	// Final sigma weighs as sigma: toLowerCase picks one or the other from the text after a capital sigma, so a
	// separate weight would let a later unit change the order of an earlier one.
	if (code === 0x3c2) {
		return 0x3c3
	}

	let weight = textUnitWeights.get(code)

	if (weight === undefined) {
		weight = decomposedWeight(code)

		textUnitWeights.set(code, weight)
	}

	return weight
}

// compareTextRuns from the first differing code unit `start`, at least one of the two being non-ASCII.
function compareTextWeights(a: string, b: string, start: number): number {
	const aLength = a.length
	const bLength = b.length
	let i = start
	let j = start

	for (;;) {
		let aWeight = -1
		let bWeight = -1

		while (aWeight === -1 && i < aLength) {
			aWeight = textUnitWeight(a.charCodeAt(i))
			i++
		}

		while (bWeight === -1 && j < bLength) {
			bWeight = textUnitWeight(b.charCodeAt(j))
			j++
		}

		// -1 here is a run that ran out: the shorter one sorts first.
		if (aWeight !== bWeight) {
			return aWeight < bWeight ? -1 : 1
		}

		if (aWeight === -1) {
			break
		}
	}

	// Same letters, different accents (or the same text composed differently): the code unit decides.
	return a.charCodeAt(start) < b.charCodeAt(start) ? -1 : 1
}

/**
 * Orders two lowercased runs of text holding no ASCII digit, the string half of every natural-order comparator here.
 * It is a total order and the same on every device and locale: runs compare unit by unit on primary weights (see
 * textUnitWeight), so "é" sorts with "e", before "f", and "日" after all of ASCII; runs with the same weights compare
 * by code unit. ASCII-only runs therefore compare exactly by code unit, as they always did, and the first difference
 * between two ASCII units is answered without a lookup or an allocation. Returns 0 only for identical runs.
 */
export function compareTextRuns(a: string, b: string): number {
	if (a === b) {
		return 0
	}

	const aLength = a.length
	const bLength = b.length
	const length = aLength < bLength ? aLength : bLength

	for (let i = 0; i < length; i++) {
		const ca = a.charCodeAt(i)
		const cb = b.charCodeAt(i)

		if (ca === cb) {
			continue
		}

		if (ca < 128 && cb < 128) {
			return ca < cb ? -1 : 1
		}

		return compareTextWeights(a, b, i)
	}

	return aLength === bLength ? 0 : aLength < bLength ? -1 : 1
}

/**
 * Fast numeric-aware comparator: digit runs compare by value, A-Z folds to a-z (case breaks ties), and other ASCII
 * characters compare by code unit. A difference involving non-ASCII text compares the two text runs it sits in with
 * `compareTextRuns`, so accented and non-Latin names order like the drive listing and the archive browser.
 */
export function fastLocaleCompare(a: string, b: string): number {
	// Fast path: identical strings
	if (a === b) {
		return 0
	}

	const lenA = a.length
	const lenB = b.length
	let idxA = 0
	let idxB = 0
	let caseDiff = 0 // Track first case difference for tiebreaker
	// Where the current text run began, the same text in both up to idxA / idxB.
	let runA = 0
	let runB = 0

	while (idxA < lenA && idxB < lenB) {
		const charA = a.charCodeAt(idxA)
		const charB = b.charCodeAt(idxB)
		const isDigitA = charA >= 48 && charA <= 57 // 0-9
		const isDigitB = charB >= 48 && charB <= 57 // 0-9

		if (isDigitA && isDigitB) {
			// Both are digits - extract and compare full numbers
			let numA = 0
			let numB = 0

			// Extract number from string a
			while (idxA < lenA) {
				const c = a.charCodeAt(idxA)

				if (c < 48 || c > 57) {
					break
				}

				numA = numA * 10 + (c - 48)
				idxA++
			}

			// Extract number from string b
			while (idxB < lenB) {
				const c = b.charCodeAt(idxB)

				if (c < 48 || c > 57) {
					break
				}

				numB = numB * 10 + (c - 48)
				idxB++
			}

			if (numA !== numB) {
				return numA < numB ? -1 : 1
			}

			runA = idxA
			runB = idxB
		} else if (isDigitA) {
			// Numbers come before non-numbers
			return -1
		} else if (isDigitB) {
			return 1
		} else {
			// Both are non-digits - compare base characters (case-insensitive)
			const lowerA = charA >= 65 && charA <= 90 ? charA + 32 : charA
			const lowerB = charB >= 65 && charB <= 90 ? charB + 32 : charB

			if (lowerA !== lowerB) {
				if (lowerA < 128 && lowerB < 128) {
					// Different letters entirely
					return lowerA < lowerB ? -1 : 1
				}

				let endA = idxA + 1
				let endB = idxB + 1

				while (endA < lenA && !isAsciiDigit(a.charCodeAt(endA))) {
					endA++
				}

				while (endB < lenB && !isAsciiDigit(b.charCodeAt(endB))) {
					endB++
				}

				const order = compareTextRuns(a.slice(runA, endA).toLowerCase(), b.slice(runB, endB).toLowerCase())

				if (order !== 0) {
					return order
				}

				// The runs differ only in case: the first such unit breaks a tie, lowercase (the higher unit) first.
				if (caseDiff === 0) {
					for (let k = 0; runA + k < endA && runB + k < endB; k++) {
						const unitA = a.charCodeAt(runA + k)
						const unitB = b.charCodeAt(runB + k)

						if (unitA !== unitB) {
							caseDiff = unitA > unitB ? -1 : 1

							break
						}
					}
				}

				idxA = runA = endA
				idxB = runB = endB

				continue
			}

			// Same letter but might differ in case - remember first case difference
			if (caseDiff === 0 && charA !== charB) {
				// lowercase comes first (97 > 65 for 'a' vs 'A')
				caseDiff = charA > charB ? -1 : 1
			}

			idxA++
			idxB++
		}
	}

	// One string is a prefix of the other
	if (idxA < lenA) {
		return 1 // a is longer
	}

	if (idxB < lenB) {
		return -1 // b is longer
	}

	// Strings are equal except for case - use case as tiebreaker
	return caseDiff
}

const FORMAT_BYTES_SIZES = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"] as const

const POWERS_1024 = [1, 1024, 1048576, 1073741824, 1099511627776, 1125899906842624] as const

function bytesUnitIndex(bytes: number): number {
	if (bytes >= POWERS_1024[5]) {
		return 5
	}

	if (bytes >= POWERS_1024[4]) {
		return 4
	}

	if (bytes >= POWERS_1024[3]) {
		return 3
	}

	if (bytes >= POWERS_1024[2]) {
		return 2
	}

	return bytes >= POWERS_1024[1] ? 1 : 0
}

const MAX_BYTES_UNIT_INDEX = POWERS_1024.length - 1

function renderBytesIn(bytes: number, unitIndex: number, fixed: boolean): string {
	const value = bytes / (POWERS_1024[unitIndex] ?? 1)

	if (!fixed) {
		return String(Math.round(value * 100) / 100)
	}

	return unitIndex === 0 ? String(Math.round(value)) : value.toFixed(1)
}

function formatScaled(bytes: number, fixed: boolean): string {
	let i = bytesUnitIndex(bytes)
	let shown = renderBytesIn(bytes, i, fixed)

	// Rounding can land a value on 1024 of its unit ("1024 KiB" just below 1 MiB), which reads as 1 of the next.
	if (Number(shown) >= 1024 && i < MAX_BYTES_UNIT_INDEX) {
		i++
		shown = renderBytesIn(bytes, i, fixed)
	}

	return `${shown} ${FORMAT_BYTES_SIZES[i] ?? ""}`
}

// Up to 2 decimals, trailing zeros dropped
export function formatBytes(bytes: number): string {
	return formatScaled(bytes, false)
}

// formatBytes with its decimals kept ("5.0 MiB", never "5 MiB"), for a figure that updates live: a
// decimal part that comes and goes would move everything after it on every tick. Whole bytes have no
// fraction to keep.
export function formatBytesFixed(bytes: number): string {
	return formatScaled(bytes, true)
}

export function formatBytesPerSecond(bytesPerSecond: number): string {
	return `${formatBytesFixed(bytesPerSecond)}/s`
}

export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}

// Reads `name` structurally, so it covers DOMException and Error as well as FFI errors
// (uniffi-bindgen-react-native, wasm-bindgen) that may not be instanceof Error. uniffi's
// FilenSdkError signals cancellation with kind "Cancelled".
export function isAbortError(error: unknown): boolean {
	if (typeof error !== "object" || error === null) {
		return false
	}

	const obj = error as Record<string, unknown>

	return obj["name"] === "AbortError" || obj["kind"] === "Cancelled"
}

export function trimmedOrUndefined(value: string): string | undefined {
	const trimmed = value.trim()

	return trimmed.length > 0 ? trimmed : undefined
}

function isAsciiOnly(value: string): boolean {
	for (let i = 0; i < value.length; i++) {
		if (value.charCodeAt(i) > 127) {
			return false
		}
	}

	return true
}

// Lowercased, then NFC only when it holds a non-ASCII unit: names are stored as uploaded, so one typed on macOS
// can be decomposed (NFD) where the query is composed, or the reverse. ASCII is its own NFC form.
function foldForNameSearch(value: string): string {
	const lower = value.toLowerCase()

	return isAsciiOnly(lower) ? lower : lower.normalize("NFC")
}

/**
 * The search key for `matchesNameSearch`: trimmed, lowercased and NFC-normalized. Compute it once per query, not
 * per row. An empty key matches every name.
 */
export function nameSearchKey(text: string): string {
	return foldForNameSearch(text.trim())
}

/**
 * Case-insensitive substring match of `name` against a key from `nameSearchKey`, independent of how either side
 * was composed. An ASCII name is only lowercased, so the common path stays a plain `toLowerCase().includes`.
 */
export function matchesNameSearch(name: string, key: string): boolean {
	return foldForNameSearch(name).includes(key)
}
