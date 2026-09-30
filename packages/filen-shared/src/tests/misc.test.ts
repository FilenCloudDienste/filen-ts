import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import {
	parseNumbersFromString,
	convertTimestampToMs,
	isValidHexColor,
	sanitizeFileName,
	findClosestIndexString,
	ratePasswordStrength,
	sortParams,
	createExecutableTimeout,
	fastLocaleCompare,
	formatBytes,
	formatBytesFixed,
	formatBytesPerSecond,
	errorMessage,
	isAbortError,
	trimmedOrUndefined
} from "@filen/shared"

describe("parseNumbersFromString", () => {
	it("should extract digits from a short string", () => {
		expect(parseNumbersFromString("abc123")).toBe(123)
	})

	it("should extract digits from a long string", () => {
		expect(parseNumbersFromString("abcdef1234567890xyz")).toBe(1234567890)
	})

	it("should return 0 for empty string", () => {
		expect(parseNumbersFromString("")).toBe(0)
	})

	it("should return 0 for string with no digits", () => {
		expect(parseNumbersFromString("abcdef")).toBe(0)
	})

	it("should handle string with only digits", () => {
		expect(parseNumbersFromString("42")).toBe(42)
	})

	it("should concatenate non-adjacent digits", () => {
		expect(parseNumbersFromString("a1b2c3")).toBe(123)
	})
})

describe("convertTimestampToMs", () => {
	it("should convert seconds timestamp to ms", () => {
		expect(convertTimestampToMs(1700000000)).toBe(1700000000000)
	})

	it("should return ms timestamp as-is", () => {
		expect(convertTimestampToMs(1700000000000)).toBe(1700000000000)
	})

	it("should treat small values as seconds", () => {
		expect(convertTimestampToMs(1000)).toBe(1000000)
	})
})

describe("isValidHexColor", () => {
	it("should accept valid 6-digit hex color", () => {
		expect(isValidHexColor("#FF00FF")).toBe(true)
	})

	it("should accept valid lowercase hex color", () => {
		expect(isValidHexColor("#aabb00")).toBe(true)
	})

	it("should reject missing hash", () => {
		expect(isValidHexColor("FF00FF")).toBe(false)
	})

	it("should reject invalid hex characters", () => {
		expect(isValidHexColor("#GGGGGG")).toBe(false)
	})

	it("should reject wrong length", () => {
		expect(isValidHexColor("#FFF")).toBe(false)
	})

	it("should accept 3-digit hex color when length=3", () => {
		expect(isValidHexColor("#FFF", 3)).toBe(true)
	})

	it("should also accept 6-digit hex color when length=3", () => {
		expect(isValidHexColor("#FFFFFF", 3)).toBe(true)
	})
})

describe("sanitizeFileName", () => {
	it("returns 'file' for empty string", () => {
		expect(sanitizeFileName("")).toBe("file")
	})

	it("returns 'file' for strings of only dots", () => {
		expect(sanitizeFileName("...")).toBe("file")
	})

	it("returns 'file' for strings of only spaces", () => {
		expect(sanitizeFileName("   ")).toBe("file")
	})

	it("returns 'file' for single dot", () => {
		expect(sanitizeFileName(".")).toBe("file")
	})

	it("returns 'file' for double dot", () => {
		expect(sanitizeFileName("..")).toBe("file")
	})

	it("strips leading dot from hidden file names", () => {
		expect(sanitizeFileName(".hidden")).toBe("hidden")
	})

	it("replaces illegal characters with default replacement '_'", () => {
		const result = sanitizeFileName("a/b:c<d>e\"f\\g|h?i*j")
		// All illegal chars replaced with _
		expect(result).not.toMatch(/[/:?<>"\\|*]/)
		expect(result).toBe("a_b_c_d_e_f_g_h_i_j")
	})

	it("respects custom replacement character", () => {
		expect(sanitizeFileName("a/b:c", "-")).toBe("a-b-c")
	})

	it("removes control characters U+0000-U+001F", () => {
		// Tab (U+0009), newline (U+000A), carriage return (U+000D) are control chars
		// Control chars U+0000 and U+001F are removed (not replaced)
		const withControl = "hel" + String.fromCharCode(0x01) + "lo"
		expect(sanitizeFileName(withControl)).toBe("hello")
	})

	it("removes zero-width characters U+200B and U+FEFF", () => {
		// Zero-width space and BOM should be stripped
		const result = sanitizeFileName("​hello﻿")
		expect(result).toBe("hello")
	})

	it("strips leading and trailing spaces: '  report  ' → 'report'", () => {
		expect(sanitizeFileName("  report  ")).toBe("report")
	})

	it("strips leading and trailing dots: '.file.' → 'file'", () => {
		expect(sanitizeFileName(".file.")).toBe("file")
	})

	it("collapses internal whitespace runs to replacement: 'a  b' → 'a_b'", () => {
		expect(sanitizeFileName("a  b")).toBe("a_b")
	})

	it("passes through a filename exactly 255 UTF-8 bytes unchanged", () => {
		// Build a 255-byte ASCII string
		const name = "a".repeat(255)
		expect(sanitizeFileName(name)).toBe(name)
	})

	it("truncates a filename over 255 bytes while preserving extension", () => {
		// Build a 300-char ASCII base name + .pdf extension
		const base = "a".repeat(300)
		const result = sanitizeFileName(`${base}.pdf`)
		const bytes = new TextEncoder().encode(result).length
		expect(bytes).toBeLessThanOrEqual(255)
		expect(result.endsWith(".pdf")).toBe(true)
	})

	it("does not treat extension longer than 10 chars as an extension during truncation", () => {
		// Extension ".abcdefghijk" is 11 chars — over the 10-char limit, should NOT be preserved
		const base = "a".repeat(300)
		const result = sanitizeFileName(`${base}.abcdefghijk`)
		const bytes = new TextEncoder().encode(result).length
		expect(bytes).toBeLessThanOrEqual(255)
		// Extension not preserved because it is too long
		expect(result.endsWith(".abcdefghijk")).toBe(false)
	})

	it("counts multibyte CJK characters by bytes during truncation", () => {
		// Each CJK character is 3 UTF-8 bytes; 90 of them = 270 bytes (> 255)
		const name = "文".repeat(90)
		const result = sanitizeFileName(name)
		const bytes = new TextEncoder().encode(result).length
		expect(bytes).toBeLessThanOrEqual(255)
	})

	it("NFC-normalizes decomposed form", () => {
		// "é" as decomposed NFD (U+0065 U+0301) should become NFC "é" (U+00E9)
		const decomposed = "é" // e + combining acute accent
		const result = sanitizeFileName(decomposed)
		// NFC normalization collapses the sequence to a single code point
		expect(result).toBe("é")
	})
	it("keeps non-ASCII characters", () => {
		expect(sanitizeFileName("日本語 ファイル.txt")).toBe("日本語_ファイル.txt")
	})

	it("removes C1 controls and the soft hyphen", () => {
		expect(sanitizeFileName("a\u0085b\u00ADc")).toBe("abc")
	})
})

describe("findClosestIndexString", () => {
	it("should find target before given index", () => {
		expect(findClosestIndexString("hello world", "hello", 10)).toBe(0)
	})

	it("should return -1 when target not found", () => {
		expect(findClosestIndexString("hello world", "xyz", 10)).toBe(-1)
	})

	it("should find last occurrence before index", () => {
		expect(findClosestIndexString("aXbXcXd", "X", 5)).toBe(5)
	})
})

// The implementation used to fall back to a loop re-slicing the source for every offset when the
// first search missed. It was quadratic AND dead — every slice it inspected was a substring of the
// one already searched. These pin the equivalence, including the multi-character case where the
// tempting `lastIndexOf(target, index)` overload would NOT be equivalent.
describe("findClosestIndexString — equivalence of the removed fallback", () => {
	function reference(sourceString: string, targetString: string, givenIndex: number): number {
		const extracted = sourceString.slice(0, givenIndex + 1)
		const within = extracted.lastIndexOf(targetString)

		if (within !== -1) {
			return within
		}

		for (let offset = 1; offset <= givenIndex; offset++) {
			const before = sourceString.slice(givenIndex - offset, givenIndex + 1)
			const at = before.lastIndexOf(targetString)

			if (at !== -1) {
				return givenIndex - offset + at
			}
		}

		return -1
	}

	it("matches the previous implementation exhaustively over a small alphabet", () => {
		const alphabet = "ab:@"
		const needles = [":", "@", "ab", ":@"]
		let checked = 0

		for (let length = 0; length <= 5; length++) {
			const total = alphabet.length ** length

			for (let n = 0; n < total; n++) {
				let source = ""
				let rest = n

				for (let k = 0; k < length; k++) {
					source += alphabet[rest % alphabet.length]
					rest = Math.floor(rest / alphabet.length)
				}

				for (const needle of needles) {
					for (let index = -1; index <= length + 1; index++) {
						expect(findClosestIndexString(source, needle, index)).toBe(reference(source, needle, index))
						checked++
					}
				}
			}
		}

		expect(checked).toBeGreaterThan(40_000)
	})

	it("bounds the whole match, not just its start (why lastIndexOf(target, index) is wrong here)", () => {
		// "ab" starts at 0 and ends at 1. Bounded by index 0 it must NOT match.
		expect(findClosestIndexString("ab", "ab", 0)).toBe(-1)
		expect(findClosestIndexString("ab", "ab", 1)).toBe(0)
		expect("ab".lastIndexOf("ab", 0)).toBe(0)
	})
})

describe("ratePasswordStrength", () => {
	it("should rate short password as weak", () => {
		expect(ratePasswordStrength("abc").strength).toBe("weak")
	})

	it("should rate password with mixed case and length as normal", () => {
		expect(ratePasswordStrength("AbcAbcAbcAbc").strength).toBe("normal")
	})

	it("should rate password with all criteria and length >= 10 as strong", () => {
		expect(ratePasswordStrength("Abcdefg!@#").strength).toBe("strong")
	})

	it("should rate password with all criteria and length >= 16 as best", () => {
		expect(ratePasswordStrength("Abcdefghijk!@#$%").strength).toBe("best")
	})

	it("should report individual criteria", () => {
		const result = ratePasswordStrength("Aa1!")

		expect(result.uppercase).toBe(true)
		expect(result.lowercase).toBe(true)
		expect(result.specialChars).toBe(true)
		expect(result.length).toBe(false)
	})
})

describe("sortParams", () => {
	it("should sort object keys alphabetically", () => {
		const result = sortParams({ c: 3, a: 1, b: 2 })

		expect(Object.keys(result)).toEqual(["a", "b", "c"])
	})

	it("should preserve values", () => {
		const result = sortParams({ b: "hello", a: 42 })

		expect(result.a).toBe(42)
		expect(result.b).toBe("hello")
	})

	it("should handle empty object", () => {
		expect(sortParams({})).toEqual({})
	})
})

describe("createExecutableTimeout", () => {
	beforeEach(() => {
		vi.useFakeTimers()
	})

	afterEach(() => {
		vi.useRealTimers()
	})

	it("should execute callback after delay", () => {
		const callback = vi.fn()

		createExecutableTimeout(callback, 100)

		expect(callback).not.toHaveBeenCalled()

		vi.advanceTimersByTime(100)

		expect(callback).toHaveBeenCalledOnce()
	})

	it("should execute immediately when execute() is called", () => {
		const callback = vi.fn()
		const timeout = createExecutableTimeout(callback, 1000)

		timeout.execute()

		expect(callback).toHaveBeenCalledOnce()
	})

	it("should cancel the timer when execute() is called", () => {
		const callback = vi.fn()
		const timeout = createExecutableTimeout(callback, 100)

		timeout.execute()

		vi.advanceTimersByTime(100)

		expect(callback).toHaveBeenCalledOnce()
	})

	it("should cancel the timer when cancel() is called", () => {
		const callback = vi.fn()
		const timeout = createExecutableTimeout(callback, 100)

		timeout.cancel()

		vi.advanceTimersByTime(200)

		expect(callback).not.toHaveBeenCalled()
	})
})

describe("fastLocaleCompare", () => {
	it("should return 0 for identical strings", () => {
		expect(fastLocaleCompare("abc", "abc")).toBe(0)
	})

	it("should compare strings alphabetically", () => {
		expect(fastLocaleCompare("apple", "banana")).toBeLessThan(0)
		expect(fastLocaleCompare("banana", "apple")).toBeGreaterThan(0)
	})

	it("should compare case-insensitively with case tiebreaker", () => {
		expect(fastLocaleCompare("abc", "ABC")).not.toBe(0)
		expect(fastLocaleCompare("abc", "abd")).toBeLessThan(0)
	})

	it("should compare numbers numerically", () => {
		expect(fastLocaleCompare("file2", "file10")).toBeLessThan(0)
		expect(fastLocaleCompare("file10", "file2")).toBeGreaterThan(0)
	})

	it("should sort numbers before letters", () => {
		expect(fastLocaleCompare("1abc", "abc")).toBeLessThan(0)
	})

	it("should handle prefix strings", () => {
		expect(fastLocaleCompare("abc", "abcd")).toBeLessThan(0)
		expect(fastLocaleCompare("abcd", "abc")).toBeGreaterThan(0)
	})

	it("should handle empty strings", () => {
		expect(fastLocaleCompare("", "")).toBe(0)
		expect(fastLocaleCompare("", "a")).toBeLessThan(0)
		expect(fastLocaleCompare("a", "")).toBeGreaterThan(0)
	})
})

describe("formatBytesPerSecond", () => {
	it("appends /s to the fixed-decimal form", () => {
		expect(formatBytesPerSecond(512)).toBe("512 B/s")
		expect(formatBytesPerSecond(1024)).toBe("1.0 KiB/s")
		expect(formatBytesPerSecond(1048576)).toBe("1.0 MiB/s")
	})

	it("shows a value that rounds up to 1024 as 1 of the next unit", () => {
		expect(formatBytesPerSecond(1023.97)).toBe("1.0 KiB/s")
		expect(formatBytesPerSecond(1024 * 1024 - 20)).toBe("1.0 MiB/s")
	})
})

describe("formatBytes", () => {
	it("should format 0 bytes", () => {
		expect(formatBytes(0)).toBe("0 B")
	})

	it("should format bytes", () => {
		expect(formatBytes(500)).toBe("500 B")
	})

	it("should format KiB", () => {
		expect(formatBytes(1024)).toBe("1 KiB")
	})

	it("should format MiB", () => {
		expect(formatBytes(1048576)).toBe("1 MiB")
	})

	it("should format GiB", () => {
		expect(formatBytes(1073741824)).toBe("1 GiB")
	})

	it("should respect decimal places", () => {
		expect(formatBytes(1536, 1)).toBe("1.5 KiB")
	})

	it("should handle negative decimals as 0", () => {
		expect(formatBytes(1536, -1)).toBe("2 KiB")
	})

	it("moves to the next unit when rounding reaches 1024 of this one", () => {
		expect(formatBytes(1048575)).toBe("1 MiB")
		expect(formatBytes(1048575, 3)).toBe("1023.999 KiB")
	})
})

describe("formatBytesFixed", () => {
	it("keeps its decimals, so a live figure keeps its length", () => {
		expect(formatBytesFixed(5 * 1048576)).toBe("5.0 MiB")
		expect(formatBytesFixed(5.25 * 1048576)).toBe("5.3 MiB")
		expect(formatBytesFixed(1536, 2)).toBe("1.50 KiB")
	})

	it("shows whole bytes without a fraction", () => {
		expect(formatBytesFixed(0)).toBe("0 B")
		expect(formatBytesFixed(500)).toBe("500 B")
	})

	it("moves to the next unit when rounding reaches 1024 of this one", () => {
		expect(formatBytesFixed(1023.6)).toBe("1.0 KiB")
		expect(formatBytesFixed(1048575)).toBe("1.0 MiB")
		expect(formatBytesFixed(1048575, 2)).toBe("1.00 MiB")
		expect(formatBytesFixed(1023 * 1024)).toBe("1023.0 KiB")
		expect(formatBytesFixed(1023)).toBe("1023 B")
	})
})

describe("errorMessage", () => {
	it("returns an Error's message", () => {
		expect(errorMessage(new TypeError("boom"))).toBe("boom")
	})

	it("stringifies non-Error values", () => {
		expect(errorMessage("plain")).toBe("plain")
		expect(errorMessage(42)).toBe("42")
		expect(errorMessage(undefined)).toBe("undefined")
		expect(errorMessage({ message: "not an Error" })).toBe("[object Object]")
	})
})

describe("isAbortError", () => {
	it("should detect DOMException with name AbortError", () => {
		expect(isAbortError(new DOMException("Aborted", "AbortError"))).toBe(true)
	})

	it("should detect Error with name AbortError", () => {
		const error = new Error("Operation aborted")

		error.name = "AbortError"

		expect(isAbortError(error)).toBe(true)
	})

	it("should detect AbortController abort reason when it is an AbortError", () => {
		const controller = new AbortController()

		controller.abort()

		expect(isAbortError(controller.signal.reason)).toBe(true)
	})

	it("should detect plain object with name AbortError (FFI/wasm-bindgen)", () => {
		expect(isAbortError({ name: "AbortError", message: "aborted" })).toBe(true)
	})

	it("should detect object with kind Cancelled (uniffi-bindgen-react-native)", () => {
		expect(isAbortError({ kind: "Cancelled", message: "Operation cancelled" })).toBe(true)
	})

	it("should return false for regular Error", () => {
		expect(isAbortError(new Error("something failed"))).toBe(false)
	})

	it("should return false for TypeError", () => {
		expect(isAbortError(new TypeError("type error"))).toBe(false)
	})

	it("should return false for non-abort DOMException", () => {
		expect(isAbortError(new DOMException("timeout", "TimeoutError"))).toBe(false)
	})

	it("should return false for object with non-cancelled kind", () => {
		expect(isAbortError({ kind: "IO", message: "disk full" })).toBe(false)
	})

	it("should return false for non-error values", () => {
		expect(isAbortError(null)).toBe(false)
		expect(isAbortError(undefined)).toBe(false)
		expect(isAbortError("AbortError")).toBe(false)
		expect(isAbortError(42)).toBe(false)
	})
})

describe("trimmedOrUndefined", () => {
	it("should return undefined for an empty string", () => {
		expect(trimmedOrUndefined("")).toBeUndefined()
	})

	it("should return undefined for a whitespace-only string", () => {
		expect(trimmedOrUndefined("   ")).toBeUndefined()
		expect(trimmedOrUndefined("\t\n")).toBeUndefined()
	})

	it("should trim padding around a non-blank value", () => {
		expect(trimmedOrUndefined("  hello  ")).toBe("hello")
	})

	it("should return the value unchanged when already trimmed", () => {
		expect(trimmedOrUndefined("hello")).toBe("hello")
	})
})
