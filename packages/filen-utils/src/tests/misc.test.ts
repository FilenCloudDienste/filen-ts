import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import {
	parseNumbersFromString,
	convertTimestampToMs,
	isValidHexColor,
	chunkArray,
	sanitizeFileName,
	findClosestIndexString,
	extractLinksFromString,
	parseYouTubeVideoId,
	parseXStatusId,
	ratePasswordStrength,
	sortParams,
	jsonBigIntReplacer,
	jsonBigIntReviver,
	createExecutableTimeout,
	fastLocaleCompare,
	bpsToReadable,
	formatBytes,
	isAbortError
} from "../misc"

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

describe("chunkArray", () => {
	it("should split array into chunks", () => {
		expect(chunkArray([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]])
	})

	it("should handle exact divisible length", () => {
		expect(chunkArray([1, 2, 3, 4], 2)).toEqual([
			[1, 2],
			[3, 4]
		])
	})

	it("should handle empty array", () => {
		expect(chunkArray([], 3)).toEqual([])
	})

	it("should handle chunk size larger than array", () => {
		expect(chunkArray([1, 2], 5)).toEqual([[1, 2]])
	})

	it("should handle chunk size of 1", () => {
		expect(chunkArray([1, 2, 3], 1)).toEqual([[1], [2], [3]])
	})
})

describe("sanitizeFileName", () => {
	it("should return filename as-is for valid names", () => {
		expect(sanitizeFileName("hello.txt")).toBe("hello.txt")
	})

	it("should replace illegal Windows characters", () => {
		const result = sanitizeFileName('file<>:"|?.txt')

		expect(result).not.toContain("<")
		expect(result).not.toContain(">")
		expect(result).not.toContain(":")
		expect(result).not.toContain('"')
		expect(result).not.toContain("|")
		expect(result).not.toContain("?")
	})

	it("should handle reserved Windows names", () => {
		const result = sanitizeFileName("CON")

		expect(result).not.toBe("CON")
		expect(result.startsWith("CON")).toBe(true)
	})

	it("should strip trailing dots and spaces", () => {
		expect(sanitizeFileName("file...")).toBe("file")
	})

	it("should return 'file' for empty result", () => {
		expect(sanitizeFileName("...")).toBe("file")
	})

	it("should use custom replacement character", () => {
		const result = sanitizeFileName("file:name", "-")

		expect(result).toBe("file-name")
	})

	it("should remove zero-width characters", () => {
		const result = sanitizeFileName("file\u200Bname.txt")

		expect(result).toBe("filename.txt")
	})

	it("should truncate to 255 bytes", () => {
		const longName = "a".repeat(300)
		const result = sanitizeFileName(longName)

		expect(new TextEncoder().encode(result).length).toBeLessThanOrEqual(255)
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

describe("extractLinksFromString", () => {
	it("should extract URLs from text", () => {
		const text = "Visit https://example.com and http://test.org for more"
		const links = extractLinksFromString(text)

		expect(links).toContain("https://example.com")
		expect(links).toContain("http://test.org")
	})

	it("should return empty array for no links", () => {
		expect(extractLinksFromString("no links here")).toEqual([])
	})

	it("should return empty array for empty string", () => {
		expect(extractLinksFromString("")).toEqual([])
	})

	it("should extract URLs with paths and query params", () => {
		const links = extractLinksFromString("check https://example.com/path?q=1&b=2#hash")

		expect(links.length).toBe(1)
		expect(links[0]).toContain("example.com/path")
	})
})

describe("parseYouTubeVideoId", () => {
	it("should parse standard YouTube URL", () => {
		expect(parseYouTubeVideoId("https://www.youtube.com/watch?v=dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ")
	})

	it("should parse short YouTube URL", () => {
		expect(parseYouTubeVideoId("https://youtu.be/dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ")
	})

	it("should parse embed URL", () => {
		expect(parseYouTubeVideoId("https://www.youtube.com/embed/dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ")
	})

	it("should return null for invalid URL", () => {
		expect(parseYouTubeVideoId("https://example.com")).toBeNull()
	})
})

describe("parseXStatusId", () => {
	it("should extract status ID from URL", () => {
		expect(parseXStatusId("https://x.com/user/status/1234567890")).toBe("1234567890")
	})

	it("should return empty string for empty URL", () => {
		expect(parseXStatusId("")).toBe("")
	})

	it("should trim whitespace from result", () => {
		expect(parseXStatusId("https://x.com/status/123 ")).toBe("123")
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

describe("jsonBigIntReplacer / jsonBigIntReviver", () => {
	it("should serialize BigInt values", () => {
		const result = jsonBigIntReplacer("key", 123n)

		expect(result).toBe("$bigint:123n")
	})

	it("should pass through non-BigInt values", () => {
		expect(jsonBigIntReplacer("key", 42)).toBe(42)
		expect(jsonBigIntReplacer("key", "hello")).toBe("hello")
	})

	it("should deserialize BigInt values", () => {
		const result = jsonBigIntReviver("key", "$bigint:123n")

		expect(result).toBe(123n)
	})

	it("should pass through non-BigInt strings", () => {
		expect(jsonBigIntReviver("key", "hello")).toBe("hello")
	})

	it("should roundtrip BigInt through JSON", () => {
		const obj = { value: 9007199254740993n }
		const json = JSON.stringify(obj, jsonBigIntReplacer)
		const parsed = JSON.parse(json, jsonBigIntReviver)

		expect(parsed.value).toBe(9007199254740993n)
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

describe("bpsToReadable", () => {
	it("should return 0.1 B/s for 0", () => {
		expect(bpsToReadable(0)).toBe("0.1 B/s")
	})

	it("should return 0.1 B/s for negative values", () => {
		expect(bpsToReadable(-100)).toBe("0.1 B/s")
	})

	it("should format values under 1 KiB as bytes", () => {
		const result = bpsToReadable(512)

		expect(result).toBe("512.0 B")
	})

	it("should format KiB range values", () => {
		const result = bpsToReadable(1024)

		expect(result).toBe("1.0 KiB")
	})

	it("should format MiB range values", () => {
		const result = bpsToReadable(1048576)

		expect(result).toBe("1.0 MiB")
	})

	it("should format GiB range values", () => {
		const result = bpsToReadable(1073741824)

		expect(result).toBe("1.0 GiB")
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

	it("should detect AbortError from run.ts AbortError class", async () => {
		const { AbortError } = await import("../run")

		expect(isAbortError(new AbortError())).toBe(true)
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
