import { validate as validateUUID } from "uuid"

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

export function chunkArray<T>(array: T[], chunkSize: number): T[][] {
	const chunks: T[][] = []

	for (let i = 0; i < array.length; i += chunkSize) {
		chunks.push(array.slice(i, i + chunkSize))
	}

	return chunks
}

// eslint-disable-next-line no-control-regex
const ZERO_WIDTH_AND_CONTROL_RE = /[\u200B-\u200D\uFEFF\u00AD\u0000-\u001F\u007F-\u009F]/g
// eslint-disable-next-line no-control-regex
const NON_ASCII_RE = /[^\x00-\x7F]/g
const ILLEGAL_CHARS_WINDOWS_RE = /[<>:"/\\|?*]/g
const ILLEGAL_CHARS_UNIX_RE = /\//g
const TRAILING_DOTS_SPACES_RE = /[. ]+$/
const WHITESPACE_RE = /\s+/g
const RESERVED_NAMES_WINDOWS: Set<string> = new Set([
	"CON",
	"PRN",
	"AUX",
	"NUL",
	"COM1",
	"COM2",
	"COM3",
	"COM4",
	"COM5",
	"COM6",
	"COM7",
	"COM8",
	"COM9",
	"LPT1",
	"LPT2",
	"LPT3",
	"LPT4",
	"LPT5",
	"LPT6",
	"LPT7",
	"LPT8",
	"LPT9"
])
const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder("utf-8", { fatal: false })

export function sanitizeFileName(filename: string, replacement: string = "_"): string {
	// Normalize to UTF-8 NFC form (canonical decomposition followed by canonical composition)
	let sanitizedFilename = filename.normalize("NFC")

	// Remove zero-width characters and other invisible/control characters
	sanitizedFilename = sanitizedFilename.replace(ZERO_WIDTH_AND_CONTROL_RE, "")

	// Replace non-ASCII characters that might cause issues
	sanitizedFilename = sanitizedFilename.replace(NON_ASCII_RE, replacement)

	sanitizedFilename = sanitizedFilename.replace(ILLEGAL_CHARS_WINDOWS_RE, replacement)
	sanitizedFilename = sanitizedFilename.replace(ILLEGAL_CHARS_UNIX_RE, replacement)
	sanitizedFilename = sanitizedFilename.replace(TRAILING_DOTS_SPACES_RE, "")
	sanitizedFilename = sanitizedFilename.replace(WHITESPACE_RE, replacement)

	if (RESERVED_NAMES_WINDOWS.has(sanitizedFilename.toUpperCase())) {
		sanitizedFilename += replacement
	}

	// Truncate to 255 bytes (filesystem limit) in O(n) instead of O(n²)
	const maxByteLength = 255
	const encoded = textEncoder.encode(sanitizedFilename)

	if (encoded.length > maxByteLength) {
		sanitizedFilename = textDecoder.decode(encoded.subarray(0, maxByteLength)).replace(/\uFFFD/g, "")
	}

	if (!sanitizedFilename) {
		return "file"
	}

	return sanitizedFilename
}

export function findClosestIndexString(sourceString: string, targetString: string, givenIndex: number): number {
	const extractedSubstring = sourceString.slice(0, givenIndex + 1)
	const lastIndexWithinExtracted = extractedSubstring.lastIndexOf(targetString)

	if (lastIndexWithinExtracted !== -1) {
		return lastIndexWithinExtracted
	}

	for (let offset = 1; offset <= givenIndex; offset++) {
		const substringBefore = sourceString.slice(givenIndex - offset, givenIndex + 1)
		const lastIndexBefore = substringBefore.lastIndexOf(targetString)

		if (lastIndexBefore !== -1) {
			return givenIndex - offset + lastIndexBefore
		}
	}

	return -1
}

export const URL_REGEX: RegExp =
	/https?:\/\/(?:www\.)?[-a-zA-Z0-9@:%._+~#=]{1,256}\.[a-zA-Z0-9()]{1,64}\b(?:[-a-zA-Z0-9()@:%_+.~#?&//=]*)/gi

export function extractLinksFromString(text: string): string[] {
	if (!text) {
		return []
	}

	const matches: IterableIterator<RegExpMatchArray> = text.matchAll(URL_REGEX)
	const results: string[] = []

	for (const match of matches) {
		if (match[0]) {
			results.push(match[0])
		}
	}

	return results
}

const HAS_UPPERCASE_RE = /[A-Z]/
const HAS_LOWERCASE_RE = /[a-z]/
const HAS_SPECIAL_CHARS_RE = /[!@#$%^&*(),.?":{}|<>]/
const YOUTUBE_VIDEO_ID_RE = /(?:\?v=|\/embed\/|\/watch\?v=|\/\w+\/\w+\/|youtu.be\/)([\w-]{11})/

export function parseYouTubeVideoId(url: string): string | null {
	const match = url.match(YOUTUBE_VIDEO_ID_RE)

	if (match && match.length === 2 && match[1]) {
		return match[1]
	}

	return null
}

const FILEN_PUBLIC_LINK_RE =
	/https?:\/\/(?:app|drive)\.filen\.io\/#\/([df])\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:%23|#)([A-Za-z0-9]{32,})/
const HEX_64_RE = /^[0-9A-Fa-f]{64}$/

export function parseFilenPublicLink(url: string): { uuid: string; key: string; type: "file" | "directory" } | null {
	if (!url || url.length === 0) {
		return null
	}

	const match = FILEN_PUBLIC_LINK_RE.exec(url)

	if (!match || match.length < 4 || !match[1] || !match[2] || !match[3]) {
		return null
	}

	const pathType: string = match[1]
	const uuid: string = match[2]
	let key: string = match[3]

	if (HEX_64_RE.test(key)) {
		try {
			key = Buffer.from(key, "hex").toString("utf8")
		} catch {
			return null
		}
	}

	if (Buffer.from(key).length !== 32 || !validateUUID(uuid) || (pathType !== "d" && pathType !== "f")) {
		return null
	}

	return {
		uuid,
		key,
		type: pathType === "d" ? "file" : "directory"
	}
}

export function parseXStatusId(url: string): string {
	const ex = url.split("/")
	const part = ex[ex.length - 1]

	if (!part) {
		return ""
	}

	return part.trim()
}

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

export function jsonBigIntReplacer(_: string, value: unknown) {
	if (typeof value === "bigint") {
		return `$bigint:${value.toString()}n`
	}

	return value
}

export function jsonBigIntReviver(_: string, value: unknown) {
	if (typeof value === "string" && value.startsWith("$bigint:") && value.endsWith("n")) {
		return BigInt(value.slice(8, -1))
	}

	return value
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

export const BPS_TO_READABLE_UNITS = ["KiB/s", "MiB/s", "GiB/s", "TiB/s", "PiB/s", "EiB/s", "ZiB/s", "YiB/s"]

export function bpsToReadable(bps: number): string {
	if (!(bps > 0 && bps < 1099511627776)) {
		return "0.1 B/s"
	}

	let i = -1
	let value = bps

	if (value >= 1024) {
		value /= 1024
		i = 0

		if (value >= 1024) {
			value /= 1024
			i = 1

			if (value >= 1024) {
				value /= 1024
				i = 2

				if (value >= 1024) {
					value /= 1024
					i = 3
				}
			}
		}
	}

	if (value < 0.1) {
		value = 0.1
	}

	if (i < 0) {
		return value.toFixed(1) + " B/s"
	}

	return value.toFixed(1) + " " + BPS_TO_READABLE_UNITS[i]
}

export const FORMAT_BYTES_SIZES = ["B", "KiB", "MiB", "GiB", "TiB", "PiB", "EiB", "ZiB", "YiB"]

export const POWERS_1024 = [1, 1024, 1048576, 1073741824, 1099511627776, 1125899906842624] as const

export function formatBytes(bytes: number, decimals: number = 2): string {
	if (bytes === 0) {
		return "0 B"
	}

	const dm = decimals < 0 ? 0 : decimals
	let i = 0

	if (bytes >= POWERS_1024[5]) {
		i = 5
	} else if (bytes >= POWERS_1024[4]) {
		i = 4
	} else if (bytes >= POWERS_1024[3]) {
		i = 3
	} else if (bytes >= POWERS_1024[2]) {
		i = 2
	} else if (bytes >= POWERS_1024[1]) {
		i = 1
	}

	const value = bytes / POWERS_1024[i]!
	const multiplier = Math.pow(10, dm)
	const rounded = Math.round(value * multiplier) / multiplier

	return rounded + " " + FORMAT_BYTES_SIZES[i]
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

		if (obj.name === "AbortError") {
			return true
		}

		// uniffi-bindgen-react-native FilenSdkError with kind "Cancelled"
		if (obj.kind === "Cancelled") {
			return true
		}
	}

	return false
}
