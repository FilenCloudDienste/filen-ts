export function parseNumbersFromString(string: string): number {
	if (!string) {
		return 0
	}

	const len = string.length

	if (len < 10) {
		let result = 0
		let hasDigit = false

		for (let i = 0; i < len; i++) {
			const code = string.charCodeAt(i)

			if (code >= 48 && code <= 57) {
				result = result * 10 + (code - 48)
				hasDigit = true
			}
		}

		return hasDigit ? result : 0
	}

	let result = 0
	let digitCount = 0
	const maxDigits = 16

	for (let i = 0; i < len && digitCount < maxDigits; i++) {
		const code = string.charCodeAt(i)

		if (code >= 48 && code <= 57) {
			result = result * 10 + (code - 48)

			digitCount++
		}
	}

	return result
}

export function convertTimestampToMs(timestamp: number): number {
	// Optimized: avoid two Math.abs calls
	// Timestamps in seconds are < 10^10, in ms are > 10^12
	// Simple threshold check is much faster
	if (timestamp < 10000000000) {
		// Less than year 2286 in seconds
		return timestamp * 1000
	}

	return timestamp
}

export function isValidHexColor(value: string, length: number = 6): boolean {
	if (value.length !== (length >= 6 ? 7 : 4) && value.length !== 7) {
		return false
	}

	if (value.charCodeAt(0) !== 35) {
		return false
	}

	const len = value.length

	for (let i = 1; i < len; i++) {
		const code = value.charCodeAt(i)

		if (!((code >= 48 && code <= 57) || (code >= 65 && code <= 70) || (code >= 97 && code <= 102))) {
			return false
		}
	}

	return true
}

// C0 and C1 controls, DEL, soft hyphen, zero-width space/joiners and the BOM
function isInvisibleCharCode(code: number): boolean {
	return (
		code <= 0x1f ||
		(code >= 0x7f && code <= 0x9f) ||
		code === 0xad ||
		(code >= 0x200b && code <= 0x200d) ||
		code === 0xfeff
	)
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
const MAX_FILE_NAME_BYTES = 255
const fileNameEncoder = new TextEncoder()

/**
 * Make `filename` safe to write as a single path component on APFS, ext4, F2FS, FAT32 and exFAT:
 * NFC-normalizes, strips control/zero-width characters, replaces the cross-platform-illegal set
 * (`/ : < > " \ | ? *`) and whitespace runs with `replacement`, removes leading/trailing dots and
 * spaces (a leading dot would hide the file), and truncates to 255 UTF-8 bytes while preserving a
 * trailing extension.
 *
 * Degenerate input (empty, all dots/spaces, `"."`, `".."`, or anything that sanitizes to empty)
 * returns `"file"`, never an empty string.
 *
 * Does NOT percent-decode or strip `%`, so the result must not reach `decodeURIComponent` unguarded.
 */
export function sanitizeFileName(filename: string, replacement: string = "_"): string {
	let sanitizedFilename = stripInvisibleChars(filename.normalize("NFC"))

	sanitizedFilename = sanitizedFilename.replace(APFS_ILLEGAL_CHARS_RE, replacement)
	sanitizedFilename = sanitizedFilename.replace(FAT_ILLEGAL_CHARS_RE, replacement)
	sanitizedFilename = sanitizedFilename.replace(LEADING_TRAILING_DOTS_SPACES_RE, "")

	if (sanitizedFilename.startsWith(".")) {
		sanitizedFilename = sanitizedFilename.slice(1) || "file"
	}

	sanitizedFilename = sanitizedFilename.replace(WHITESPACE_RUN_RE, replacement)

	// Filesystem limits count bytes, not characters
	if (fileNameEncoder.encode(sanitizedFilename).length > MAX_FILE_NAME_BYTES) {
		const extension = sanitizedFilename.match(TRUNCATION_EXTENSION_RE)?.[1] ?? ""
		const maxNameBytes = MAX_FILE_NAME_BYTES - fileNameEncoder.encode(extension).length
		let baseName = extension ? sanitizedFilename.slice(0, -extension.length) : sanitizedFilename

		while (fileNameEncoder.encode(baseName).length > maxNameBytes && baseName.length > 0) {
			baseName = baseName.slice(0, -1)
		}

		sanitizedFilename = baseName + extension
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

const HAS_UPPERCASE_RE = /[A-Z]/
const HAS_LOWERCASE_RE = /[a-z]/
const HAS_SPECIAL_CHARS_RE = /[!@#$%^&*(),.?":{}|<>]/

export function ratePasswordStrength(password: string): {
	strength: "weak" | "normal" | "strong" | "best"
	uppercase: boolean
	lowercase: boolean
	specialChars: boolean
	length: boolean
} {
	const hasUppercase = HAS_UPPERCASE_RE.test(password)
	const hasLowercase = HAS_LOWERCASE_RE.test(password)
	const hasSpecialChars = HAS_SPECIAL_CHARS_RE.test(password)
	const length = password.length

	let strength: "weak" | "normal" | "strong" | "best" = "weak"

	if (length >= 10 && hasUppercase && hasLowercase && hasSpecialChars) {
		if (length >= 16) {
			strength = "best"
		} else {
			strength = "strong"
		}
	} else if (length >= 10 && ((hasUppercase && hasLowercase) || (hasUppercase && hasSpecialChars) || (hasLowercase && hasSpecialChars))) {
		strength = "normal"
	}

	return {
		strength,
		uppercase: hasUppercase,
		lowercase: hasLowercase,
		specialChars: hasSpecialChars,
		length: length >= 10
	}
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
	let timeoutId: ReturnType<typeof setTimeout> | null = setTimeout(callback, delay)

	return {
		id: timeoutId,
		execute: () => {
			if (timeoutId !== null) {
				clearTimeout(timeoutId)

				timeoutId = null
			}

			callback()
		},
		cancel: () => {
			if (timeoutId !== null) {
				clearTimeout(timeoutId)

				timeoutId = null
			}
		}
	}
}

/**
 * Fast replacement for string.localeCompare(string, "en", { numeric: true })
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
				// Different letters entirely
				return lowerA < lowerB ? -1 : 1
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

export const FORMAT_BYTES_SIZES = ["B", "KiB", "MiB", "GiB", "TiB", "PiB", "EiB", "ZiB", "YiB"]

export const POWERS_1024 = [1, 1024, 1048576, 1073741824, 1099511627776, 1125899906842624] as const

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

// Rounding can land a value on 1024 of its unit ("1024 KiB" just below 1 MiB), which reads as 1 of the next.
const MAX_BYTES_UNIT_INDEX = POWERS_1024.length - 1

function bytesInUnit(bytes: number, unitIndex: number): number {
	return bytes / (POWERS_1024[unitIndex] ?? 1)
}

export function formatBytes(bytes: number, decimals: number = 2): string {
	if (bytes === 0) {
		return "0 B"
	}

	const multiplier = Math.pow(10, decimals < 0 ? 0 : decimals)
	const roundedIn = (unitIndex: number): number => Math.round(bytesInUnit(bytes, unitIndex) * multiplier) / multiplier
	let i = bytesUnitIndex(bytes)
	let rounded = roundedIn(i)

	if (rounded >= 1024 && i < MAX_BYTES_UNIT_INDEX) {
		i++
		rounded = roundedIn(i)
	}

	return rounded + " " + FORMAT_BYTES_SIZES[i]
}

// formatBytes with its decimals kept ("5.0 MiB", never "5 MiB"), for a figure that updates live: a
// decimal part that comes and goes would move everything after it on every tick. Whole bytes have no
// fraction to keep.
export function formatBytesFixed(bytes: number, decimals: number = 1): string {
	const places = Math.max(0, decimals)
	const shownIn = (unitIndex: number): string =>
		unitIndex === 0 ? String(Math.round(bytes)) : bytesInUnit(bytes, unitIndex).toFixed(places)
	let i = bytesUnitIndex(bytes)
	let shown = shownIn(i)

	if (Number(shown) >= 1024 && i < MAX_BYTES_UNIT_INDEX) {
		i++
		shown = shownIn(i)
	}

	return `${shown} ${FORMAT_BYTES_SIZES[i] ?? ""}`
}

export function formatBytesPerSecond(bytesPerSecond: number): string {
	return `${formatBytesFixed(bytesPerSecond)}/s`
}

export function isAbortError(error: unknown): boolean {
	if (error instanceof DOMException && error.name === "AbortError") {
		return true
	}

	if (error instanceof Error && error.name === "AbortError") {
		return true
	}

	// Handle FFI errors (uniffi-bindgen-react-native, wasm-bindgen)
	// that may not be instanceof Error
	if (typeof error === "object" && error !== null) {
		const obj = error as Record<string, unknown>

		if (obj["name"] === "AbortError") {
			return true
		}

		// uniffi-bindgen-react-native FilenSdkError with kind "Cancelled"
		if (obj["kind"] === "Cancelled") {
			return true
		}
	}

	return false
}

export function trimmedOrUndefined(value: string): string | undefined {
	const trimmed = value.trim()

	return trimmed.length > 0 ? trimmed : undefined
}
