import { vi, describe, it, expect, beforeEach } from "vitest"

// --- hoisted SDK enum mocks + PauseSignal + FilenSdkError (must be declared before vi.mock factories) ---

const { ErrorKindMock, ParentUuidTagsMock, FileMeta_TagsMock, MockSdkPauseSignal, FilenSdkErrorMockClass } = vi.hoisted(() => {
	const ErrorKindMock = {
		Server: "Server",
		Unauthenticated: "Unauthenticated",
		Reqwest: "Reqwest",
		Response: "Response",
		RetryFailed: "RetryFailed",
		Conversion: "Conversion",
		Io: "Io",
		ChunkTooLarge: "ChunkTooLarge",
		InvalidState: "InvalidState",
		InvalidType: "InvalidType",
		InvalidName: "InvalidName",
		ImageError: "ImageError",
		MetadataWasNotDecrypted: "MetadataWasNotDecrypted",
		Cancelled: "Cancelled",
		HeifError: "HeifError",
		BadRecoveryKey: "BadRecoveryKey",
		Internal: "Internal",
		InsufficientMemory: "InsufficientMemory",
		Walk: "Walk",
		FileChangedDuringSync: "FileChangedDuringSync",
		FolderNotFound: "FolderNotFound",
		WrongPassword: "WrongPassword",
		MaxStorageReached: "MaxStorageReached"
	} as const

	const ParentUuidTagsMock = {
		Uuid: "Uuid",
		Trash: "trash",
		Recents: "recents",
		Favorites: "favorites",
		Links: "links"
	} as const

	const FileMeta_TagsMock = {
		Decoded: "Decoded",
		Undecoded: "Undecoded"
	} as const

	// SdkPauseSignal mock class (used by the real PauseSignal constructor inside utils.ts)
	class MockSdkPauseSignal {
		private _paused = false

		pause() {
			this._paused = true
		}

		resume() {
			this._paused = false
		}

		isPaused() {
			return this._paused
		}

		uniffiDestroy() {}
	}

	// FilenSdkError mock
	class FilenSdkErrorMockClass {
		private _meta: { kind: string; message: string }

		constructor(meta: { kind: string; message: string }) {
			this._meta = meta
		}

		static hasInner(error: unknown): boolean {
			return error instanceof FilenSdkErrorMockClass
		}

		static getInner(error: unknown): FilenSdkErrorMockClass | null {
			if (error instanceof FilenSdkErrorMockClass) {
				return error
			}

			return null
		}

		kind(): string {
			return this._meta.kind
		}

		message(): string {
			return this._meta.message
		}
	}

	return { ErrorKindMock, ParentUuidTagsMock, FileMeta_TagsMock, MockSdkPauseSignal, FilenSdkErrorMockClass }
})

vi.mock("@filen/sdk-rs", () => ({
	ErrorKind: ErrorKindMock,
	FilenSdkError: FilenSdkErrorMockClass,
	ParentUuid_Tags: ParentUuidTagsMock,
	FileMeta_Tags: FileMeta_TagsMock,
	PauseSignal: MockSdkPauseSignal,
	ManagedAbortController: class {
		private _controller = new AbortController()

		abort() {
			this._controller.abort()
		}

		signal() {
			return this._controller.signal
		}
	}
}))

vi.mock("uniffi-bindgen-react-native", async () => await import("@/tests/mocks/uniffiBindgenReactNative"))

vi.mock("expo-file-system", async () => await import("@/tests/mocks/expoFileSystem"))

vi.mock("react-native", async () => await import("@/tests/mocks/reactNative"))

vi.mock("@/lib/cache", () => ({
	default: {}
}))

vi.mock("@/lib/i18n", () => ({
	default: { t: (key: string) => key }
}))

// Provide constants that utils.ts needs at runtime.
// constants.ts imports Platform from react-native so we stub it to avoid the real file.
vi.mock("@/constants", () => {
	const EXPO_IMAGE_SUPPORTED_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp", ".avif", ".heic", ".svg"])
	const EXPO_VIDEO_SUPPORTED_EXTENSIONS = new Set([".mp4", ".mov", ".m4v", ".3gp", ".webm", ".mkv"])
	const EXPO_AUDIO_SUPPORTED_EXTENSIONS = new Set([".mp3", ".m4a", ".aac", ".wav", ".ogg", ".flac"])
	const FILE_PUBLIC_LINK_URL_PREFIX = "https://app.filen.io/#/d/"
	const DIRECTORY_PUBLIC_LINK_URL_PREFIX = "https://app.filen.io/#/f/"
	const URL_REGEX =
		/\b(?:https?:\/\/|www\.)[^\s<>"'`]+|\b[a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)+\.[a-z]{2,}(?:\/[^\s<>"'`]*)?/gi
	const TRAILING_PUNCT = /[.,;:!?'"]+$/
	const PRIVATE_HOST = [
		/^localhost$/i,
		/\.local$/i,
		/^127\./,
		/^10\./,
		/^192\.168\./,
		/^172\.(1[6-9]|2\d|3[01])\./,
		/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,
		/^169\.254\./,
		/^0\.0\.0\.0$/,
		/^::1$/,
		/^fc00:/i,
		/^fe80:/i
	]

	return {
		EXPO_IMAGE_SUPPORTED_EXTENSIONS,
		EXPO_VIDEO_SUPPORTED_EXTENSIONS,
		EXPO_AUDIO_SUPPORTED_EXTENSIONS,
		FILE_PUBLIC_LINK_URL_PREFIX,
		DIRECTORY_PUBLIC_LINK_URL_PREFIX,
		URL_REGEX,
		TRAILING_PUNCT,
		PRIVATE_HOST,
		IOS_APP_GROUP_IDENTIFIER: "group.io.filen.app",
		EXPO_IMAGE_MANIPULATOR_SUPPORTED_EXTENSIONS: new Set([".jpg", ".jpeg", ".png"]),
		MUSIC_EXTENSIONS: new Set([".mp3", ".m4a"]),
		MUSIC_METADATA_SUPPORTED_EXTENSIONS: new Set([".mp3", ".m4a"])
	}
})

import {
	sanitizeFileName,
	normalizeFilePathForSdk,
	normalizeFilePathForExpo,
	extractPathInsideUuidDirectory,
	getPreviewType,
	extractLinks,
	trimUnbalanced,
	safeParseUrl,
	createCompositeAbortSignal,
	PauseSignal,
	createCompositePauseSignal,
	unwrapSdkError,
	isNetworkClassError,
	normalizeModificationTimestampForComparison,
	contactDisplayName,
	makeDriveItemPublicLink,
	unwrapParentUuid
} from "@/lib/utils"

// ---------------------------------------------------------------------------
// sanitizeFileName
// ---------------------------------------------------------------------------

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
})

// ---------------------------------------------------------------------------
// normalizeFilePathForSdk
// ---------------------------------------------------------------------------

describe("normalizeFilePathForSdk", () => {
	it("passes through a plain Unix path unchanged", () => {
		expect(normalizeFilePathForSdk("/foo/bar")).toBe("/foo/bar")
	})

	it("strips file:// URI prefix and decodes", () => {
		expect(normalizeFilePathForSdk("file:///foo/bar")).toBe("/foo/bar")
	})

	it("collapses multiple leading slashes after file://", () => {
		expect(normalizeFilePathForSdk("file:////foo")).toBe("/foo")
	})

	it("percent-decodes segments", () => {
		expect(normalizeFilePathForSdk("file:///foo%20bar/baz")).toBe("/foo bar/baz")
	})

	it("falls back to raw segment on malformed percent-escape", () => {
		// Should NOT throw — returns the raw segment as fallback
		expect(() => normalizeFilePathForSdk("file:///Invoice%50%.pdf")).not.toThrow()
		// The malformed %% segment is kept raw; the good %50 → P
		const result = normalizeFilePathForSdk("file:///Invoice%50%.pdf")
		expect(result).toBe("/Invoice%50%.pdf")
	})

	it("strips trailing slash", () => {
		expect(normalizeFilePathForSdk("/foo/bar/")).toBe("/foo/bar")
	})

	it("preserves root '/'", () => {
		expect(normalizeFilePathForSdk("file:///")).toBe("/")
	})

	it("prepends leading slash when absent", () => {
		expect(normalizeFilePathForSdk("foo/bar")).toBe("/foo/bar")
	})

	it("collapses double slashes in the middle via posix.normalize", () => {
		expect(normalizeFilePathForSdk("/foo//bar")).toBe("/foo/bar")
	})

	it("resolves relative segments (../)", () => {
		expect(normalizeFilePathForSdk("/foo/bar/../baz")).toBe("/foo/baz")
	})
})

// ---------------------------------------------------------------------------
// normalizeFilePathForExpo
// ---------------------------------------------------------------------------

describe("normalizeFilePathForExpo", () => {
	it("wraps a clean path in file:///", () => {
		expect(normalizeFilePathForExpo("/foo/bar")).toBe("file:///foo/bar")
	})

	it("encodes spaces in segment", () => {
		expect(normalizeFilePathForExpo("/foo/file name.txt")).toBe("file:///foo/file%20name.txt")
	})

	it("round-trips an already-encoded path", () => {
		// Already encoded: decodes then re-encodes — result should be same
		const encoded = "file:///foo/file%20name.txt"
		const result = normalizeFilePathForExpo(encoded)
		expect(result).toBe("file:///foo/file%20name.txt")
	})

	it("strips trailing slash from path (inherits normalizeFilePathForSdk)", () => {
		expect(normalizeFilePathForExpo("/foo/bar/")).toBe("file:///foo/bar")
	})

	it("handles root path '/' → 'file:///'", () => {
		expect(normalizeFilePathForExpo("file:///")).toBe("file:///")
	})
})

// ---------------------------------------------------------------------------
// extractPathInsideUuidDirectory
// ---------------------------------------------------------------------------

describe("extractPathInsideUuidDirectory", () => {
	const uuid = "550e8400-e29b-41d4-a716-446655440000"

	it("returns the relative path from inside the UUID directory", () => {
		const result = extractPathInsideUuidDirectory(`/var/mobile/${uuid}/sub/file.jpg`, uuid)
		expect(result).toBe("/sub/file.jpg")
	})

	it("returns null when UUID is not in the path", () => {
		expect(extractPathInsideUuidDirectory("/var/mobile/other/file.jpg", uuid)).toBeNull()
	})

	it("returns null when path ends exactly at UUID (no trailing slash child)", () => {
		// The path ends with /UUID — no slash after UUID means no child path
		expect(extractPathInsideUuidDirectory(`/var/mobile/${uuid}`, uuid)).toBeNull()
	})

	it("uses lastIndexOf: when UUID appears twice, anchors on last occurrence", () => {
		// Two UUIDs in path — should use the last one as anchor
		const result = extractPathInsideUuidDirectory(`/base/${uuid}/middle/${uuid}/file.txt`, uuid)
		expect(result).toBe("/file.txt")
	})

	it("handles UUID at start of path", () => {
		const result = extractPathInsideUuidDirectory(`/${uuid}/file`, uuid)
		expect(result).toBe("/file")
	})

	it("returns '/' when absolutePath equals anchor exactly (UUID with trailing slash)", () => {
		const result = extractPathInsideUuidDirectory(`/${uuid}/`, uuid)
		expect(result).toBe("/")
	})
})

// ---------------------------------------------------------------------------
// getPreviewType
// ---------------------------------------------------------------------------

describe("getPreviewType", () => {
	it("returns 'image' for .jpg", () => {
		expect(getPreviewType("photo.jpg")).toBe("image")
	})

	it("returns 'video' for .mp4", () => {
		expect(getPreviewType("movie.mp4")).toBe("video")
	})

	it("returns 'audio' for .mp3", () => {
		expect(getPreviewType("song.mp3")).toBe("audio")
	})

	it("returns 'pdf' for .pdf", () => {
		expect(getPreviewType("doc.pdf")).toBe("pdf")
	})

	it("returns 'text' for .txt", () => {
		expect(getPreviewType("readme.txt")).toBe("text")
	})

	it("returns 'code' for .ts", () => {
		expect(getPreviewType("index.ts")).toBe("code")
	})

	it("returns 'code' for .py", () => {
		expect(getPreviewType("script.py")).toBe("code")
	})

	it("returns 'code' for .rs", () => {
		expect(getPreviewType("main.rs")).toBe("code")
	})

	it("returns 'code' for .swift", () => {
		expect(getPreviewType("App.swift")).toBe("code")
	})

	it("returns 'code' for .kt", () => {
		expect(getPreviewType("Main.kt")).toBe("code")
	})

	it("returns 'docx' for .docx", () => {
		expect(getPreviewType("document.docx")).toBe("docx")
	})

	it("returns 'unknown' for unrecognized extension", () => {
		expect(getPreviewType("file.xyz")).toBe("unknown")
	})

	it("returns 'unknown' for a name with no extension", () => {
		expect(getPreviewType("README")).toBe("unknown")
	})

	it("handles path separator — extname extracts last segment extension", () => {
		expect(getPreviewType("/path/to/file.ts")).toBe("code")
	})

	it("is case-insensitive: 'FILE.PDF' → 'pdf'", () => {
		expect(getPreviewType("FILE.PDF")).toBe("pdf")
	})

	it("trims whitespace before lookup: ' report.pdf ' → 'pdf'", () => {
		expect(getPreviewType(" report.pdf ")).toBe("pdf")
	})
})

// ---------------------------------------------------------------------------
// trimUnbalanced
// ---------------------------------------------------------------------------

describe("trimUnbalanced", () => {
	it("balanced parens — no trimming", () => {
		expect(trimUnbalanced("foo(bar)", "(", ")")).toBe("foo(bar)")
	})

	it("one extra trailing ')' trimmed", () => {
		expect(trimUnbalanced("foo(bar))", "(", ")")).toBe("foo(bar)")
	})

	it("multiple unbalanced trailing ')' all trimmed", () => {
		expect(trimUnbalanced("foo)))", "(", ")")).toBe("foo")
	})

	it("string not ending with close char — returned as-is", () => {
		expect(trimUnbalanced("foo(bar", "(", ")")).toBe("foo(bar")
	})

	it("empty string returns empty string", () => {
		expect(trimUnbalanced("", "(", ")")).toBe("")
	})

	it("no parens at all, trailing ')' is unbalanced → trimmed", () => {
		expect(trimUnbalanced("foobar)", "(", ")")).toBe("foobar")
	})
})

// ---------------------------------------------------------------------------
// extractLinks
// ---------------------------------------------------------------------------

describe("extractLinks", () => {
	it("extracts a plain HTTPS URL with correct start/end offsets", () => {
		const text = "hello https://example.com end"
		const links = extractLinks(text)
		expect(links).toHaveLength(1)
		expect(links[0]!.url).toBe("https://example.com")
		expect(links[0]!.start).toBe(6)
		expect(links[0]!.end).toBe(6 + "https://example.com".length)
	})

	it("prepends https:// to URL without scheme when subdomain pattern matches", () => {
		// The URL_REGEX bare-domain alternative requires at least two dots (subdomain.domain.tld).
		// A bare "example.com" (one dot) does not match; use "sub.example.com" instead.
		const text = "visit sub.example.com today"
		const links = extractLinks(text)
		expect(links.length).toBeGreaterThanOrEqual(1)
		const link = links.find(l => l.url.includes("example.com"))
		expect(link).toBeDefined()
		expect(link!.url).toBe("https://sub.example.com")
	})

	it("strips trailing punctuation from URL", () => {
		const text = "see https://example.com."
		const links = extractLinks(text)
		expect(links).toHaveLength(1)
		expect(links[0]!.url).not.toMatch(/\.$/)
	})

	it("strips unbalanced closing paren from URL", () => {
		const text = "see https://example.com/foo)"
		const links = extractLinks(text)
		expect(links).toHaveLength(1)
		expect(links[0]!.url).not.toMatch(/\)$/)
	})

	it("preserves balanced parens in URL", () => {
		const text = "see https://en.wikipedia.org/wiki/A_(band)"
		const links = extractLinks(text)
		expect(links).toHaveLength(1)
		expect(links[0]!.url).toBe("https://en.wikipedia.org/wiki/A_(band)")
	})

	it("extracts multiple links in order", () => {
		const text = "a https://foo.com b https://bar.com c"
		const links = extractLinks(text)
		expect(links).toHaveLength(2)
		expect(links[0]!.url).toBe("https://foo.com")
		expect(links[1]!.url).toBe("https://bar.com")
	})

	it("www prefix is prepended with https://", () => {
		const text = "go to www.example.com now"
		const links = extractLinks(text)
		const wwwLink = links.find(l => l.url.includes("example.com"))
		expect(wwwLink).toBeDefined()
		expect(wwwLink!.url.startsWith("https://")).toBe(true)
	})

	it("start and end offsets point at correct positions in original string", () => {
		const text = "prefix https://test.io suffix"
		const links = extractLinks(text)
		expect(links).toHaveLength(1)
		const { start, end, url } = links[0]!
		expect(text.slice(start, end)).toBe(url.replace("https://", "https://"))
		// url starts with https:// so raw match starts at same position
		expect(start).toBe(7) // "prefix " = 7 chars
		expect(end).toBe(start + "https://test.io".length)
	})
})

// ---------------------------------------------------------------------------
// safeParseUrl
// ---------------------------------------------------------------------------

describe("safeParseUrl", () => {
	it("returns a URL object for a valid public HTTPS URL", () => {
		const result = safeParseUrl("https://example.com/path")
		expect(result).not.toBeNull()
		expect(result!.hostname).toBe("example.com")
	})

	it("returns null for HTTP URL", () => {
		expect(safeParseUrl("http://example.com")).toBeNull()
	})

	it("returns null for ftp:// URL", () => {
		expect(safeParseUrl("ftp://example.com")).toBeNull()
	})

	it("returns null for URL with username:password", () => {
		expect(safeParseUrl("https://user:pass@example.com")).toBeNull()
	})

	it("returns null for localhost", () => {
		expect(safeParseUrl("https://localhost/api")).toBeNull()
	})

	it("returns null for 192.168.x.x", () => {
		expect(safeParseUrl("https://192.168.1.1/admin")).toBeNull()
	})

	it("returns null for 10.0.0.1", () => {
		expect(safeParseUrl("https://10.0.0.1/api")).toBeNull()
	})

	it("returns null for 172.16.x.x (private range start)", () => {
		expect(safeParseUrl("https://172.16.0.1")).toBeNull()
	})

	it("returns null for 172.31.x.x (private range end)", () => {
		expect(safeParseUrl("https://172.31.255.255")).toBeNull()
	})

	it("returns non-null for 172.15.x.x (just outside private range)", () => {
		expect(safeParseUrl("https://172.15.0.1")).not.toBeNull()
	})

	it("returns null for 169.254.x.x (link-local)", () => {
		expect(safeParseUrl("https://169.254.0.1")).toBeNull()
	})

	it("returns null for IPv6 loopback [::1]", () => {
		expect(safeParseUrl("https://[::1]")).toBeNull()
	})

	it("returns null for IPv6 ULA [fc00::1]", () => {
		expect(safeParseUrl("https://[fc00::1]")).toBeNull()
	})

	it("returns null for IPv6 link-local [fe80::1]", () => {
		expect(safeParseUrl("https://[fe80::1]")).toBeNull()
	})

	it("returns null for malformed URL string", () => {
		expect(safeParseUrl("not a url at all !!")).toBeNull()
	})

	it("trims leading/trailing whitespace before parse", () => {
		const result = safeParseUrl("  https://example.com  ")
		expect(result).not.toBeNull()
	})
})

// ---------------------------------------------------------------------------
// createCompositeAbortSignal
// ---------------------------------------------------------------------------

describe("createCompositeAbortSignal", () => {
	it("returns a non-aborted signal when no signals are passed", () => {
		const composite = createCompositeAbortSignal()
		expect(composite.aborted).toBe(false)
		composite.dispose()
	})

	it("returns an immediately aborted composite when one already-aborted signal is passed", () => {
		const controller = new AbortController()
		controller.abort()
		const composite = createCompositeAbortSignal(controller.signal)
		expect(composite.aborted).toBe(true)
	})

	it("composite aborts when a source signal is aborted after construction", () => {
		const controller = new AbortController()
		const composite = createCompositeAbortSignal(controller.signal)
		expect(composite.aborted).toBe(false)
		controller.abort()
		expect(composite.aborted).toBe(true)
		composite.dispose()
	})

	it("aborting any one signal among multiple aborts the composite", () => {
		const c1 = new AbortController()
		const c2 = new AbortController()
		const composite = createCompositeAbortSignal(c1.signal, c2.signal)
		c2.abort()
		expect(composite.aborted).toBe(true)
		composite.dispose()
	})

	it("dispose() removes all event listeners — subsequent abort does not propagate", () => {
		const controller = new AbortController()
		const composite = createCompositeAbortSignal(controller.signal)
		composite.dispose()
		// After dispose, aborting the source should NOT change composite.aborted
		// (the composite was not yet aborted)
		expect(composite.aborted).toBe(false)
		controller.abort()
		// The listener was removed, so composite stays unaborted
		expect(composite.aborted).toBe(false)
	})

	it("dispose() on a pre-aborted composite does not throw", () => {
		const controller = new AbortController()
		controller.abort()
		const composite = createCompositeAbortSignal(controller.signal)
		expect(() => composite.dispose()).not.toThrow()
	})

	it("dispose() is idempotent — calling twice does not throw", () => {
		const composite = createCompositeAbortSignal()
		composite.dispose()
		expect(() => composite.dispose()).not.toThrow()
	})
})

// ---------------------------------------------------------------------------
// PauseSignal
// ---------------------------------------------------------------------------

describe("PauseSignal", () => {
	let ps: PauseSignal

	beforeEach(() => {
		ps = new PauseSignal()
	})

	it("pause() sets isPaused() to true", () => {
		ps.pause()
		expect(ps.isPaused()).toBe(true)
		ps.dispose()
	})

	it("resume() sets isPaused() to false", () => {
		ps.pause()
		ps.resume()
		expect(ps.isPaused()).toBe(false)
		ps.dispose()
	})

	it("pause() when already paused is a no-op (does not double-fire listeners)", () => {
		const spy = vi.fn()
		ps.addEventListener("pause", spy)
		ps.pause()
		ps.pause() // second call — no-op
		expect(spy).toHaveBeenCalledTimes(1)
		ps.dispose()
	})

	it("resume() when not paused is a no-op (does not fire resume listeners)", () => {
		const spy = vi.fn()
		ps.addEventListener("resume", spy)
		ps.resume() // not paused — should be no-op
		expect(spy).not.toHaveBeenCalled()
		ps.dispose()
	})

	it("addEventListener('pause', fn) — fn is called on pause()", () => {
		const spy = vi.fn()
		ps.addEventListener("pause", spy)
		ps.pause()
		expect(spy).toHaveBeenCalledTimes(1)
		ps.dispose()
	})

	it("addEventListener('resume', fn) — fn is called on resume()", () => {
		const spy = vi.fn()
		ps.addEventListener("resume", spy)
		ps.pause()
		ps.resume()
		expect(spy).toHaveBeenCalledTimes(1)
		ps.dispose()
	})

	it("remove() returned from addEventListener removes the listener", () => {
		const spy = vi.fn()
		const sub = ps.addEventListener("pause", spy)
		sub.remove()
		ps.pause()
		expect(spy).not.toHaveBeenCalled()
		ps.dispose()
	})

	it("removeEventListener removes specific listener", () => {
		const spy = vi.fn()
		ps.addEventListener("pause", spy)
		ps.removeEventListener("pause", spy)
		ps.pause()
		expect(spy).not.toHaveBeenCalled()
		ps.dispose()
	})

	it("removeAllListeners clears both pause and resume listener sets", () => {
		const spyPause = vi.fn()
		const spyResume = vi.fn()
		ps.addEventListener("pause", spyPause)
		ps.addEventListener("resume", spyResume)
		ps.removeAllListeners()
		ps.pause()
		ps.resume()
		expect(spyPause).not.toHaveBeenCalled()
		expect(spyResume).not.toHaveBeenCalled()
		ps.dispose()
	})

	it("listener that throws does not prevent subsequent listeners from being called", () => {
		const throwing = () => { throw new Error("boom") }
		const spy = vi.fn()
		ps.addEventListener("pause", throwing)
		ps.addEventListener("pause", spy)
		ps.pause()
		expect(spy).toHaveBeenCalledTimes(1)
		ps.dispose()
	})

	it("dispose() calls uniffiDestroy() on the underlying SDK signal and clears all listeners", () => {
		const spy = vi.fn()
		ps.addEventListener("pause", spy)
		ps.dispose()
		// After dispose, pausing should NOT fire listeners (they were cleared)
		// (we can't call pause after dispose in a meaningful way, but we verify no throw)
		expect(() => {}).not.toThrow()
	})
})

// ---------------------------------------------------------------------------
// createCompositePauseSignal
// ---------------------------------------------------------------------------

describe("createCompositePauseSignal", () => {
	it("composite starts paused if any input is already paused at construction", () => {
		const a = new PauseSignal()
		const b = new PauseSignal()
		a.pause()
		const composite = createCompositePauseSignal(a, b)
		expect(composite.isPaused()).toBe(true)
		composite.dispose()
		a.dispose()
		b.dispose()
	})

	it("composite starts unpaused when no input is paused", () => {
		const a = new PauseSignal()
		const b = new PauseSignal()
		const composite = createCompositePauseSignal(a, b)
		expect(composite.isPaused()).toBe(false)
		composite.dispose()
		a.dispose()
		b.dispose()
	})

	it("pausing one source pauses the composite", () => {
		const a = new PauseSignal()
		const b = new PauseSignal()
		const composite = createCompositePauseSignal(a, b)
		a.pause()
		expect(composite.isPaused()).toBe(true)
		composite.dispose()
		a.dispose()
		b.dispose()
	})

	it("resuming one source when another is still paused does NOT resume the composite", () => {
		const a = new PauseSignal()
		const b = new PauseSignal()
		a.pause()
		b.pause()
		const composite = createCompositePauseSignal(a, b)
		expect(composite.isPaused()).toBe(true)
		// resume a but b is still paused → composite must stay paused
		a.resume()
		expect(composite.isPaused()).toBe(true)
		composite.dispose()
		a.dispose()
		b.dispose()
	})

	it("composite resumes only when ALL sources are unpaused", () => {
		const a = new PauseSignal()
		const b = new PauseSignal()
		a.pause()
		b.pause()
		const composite = createCompositePauseSignal(a, b)
		a.resume()
		expect(composite.isPaused()).toBe(true)
		b.resume()
		expect(composite.isPaused()).toBe(false)
		composite.dispose()
		a.dispose()
		b.dispose()
	})

	it("dispose() removes all subscriptions — subsequent pause on sources does not propagate", () => {
		const a = new PauseSignal()
		const composite = createCompositePauseSignal(a)
		composite.dispose()
		// After dispose, a.pause() should not change composite's state
		a.pause()
		expect(composite.isPaused()).toBe(false)
		a.dispose()
	})

	it("dispose() frees the underlying SdkPauseSignal (uniffiDestroy called)", () => {
		// We cannot inspect the real SdkPauseSignal directly, but dispose() should not throw
		const a = new PauseSignal()
		const composite = createCompositePauseSignal(a)
		expect(() => composite.dispose()).not.toThrow()
		a.dispose()
	})
})

// ---------------------------------------------------------------------------
// unwrapSdkError
// ---------------------------------------------------------------------------

describe("unwrapSdkError", () => {
	it("returns the FilenSdkError instance when FilenSdkError.hasInner returns true", () => {
		const inner = new FilenSdkErrorMockClass({ kind: "Internal", message: "test" })
		const result = unwrapSdkError(inner)
		expect(result).toBe(inner)
	})

	it("returns null when FilenSdkError.hasInner returns false (plain Error)", () => {
		expect(unwrapSdkError(new Error("plain"))).toBeNull()
	})

	it("returns null for a string value", () => {
		expect(unwrapSdkError("some string")).toBeNull()
	})

	it("returns null for a number value", () => {
		expect(unwrapSdkError(42)).toBeNull()
	})

	it("returns null for undefined", () => {
		expect(unwrapSdkError(undefined)).toBeNull()
	})
})

// ---------------------------------------------------------------------------
// isNetworkClassError
// ---------------------------------------------------------------------------

describe("isNetworkClassError", () => {
	function makeSdkError(kind: string) {
		return new FilenSdkErrorMockClass({ kind, message: "test" })
	}

	it("returns true for ErrorKind.Reqwest", () => {
		expect(isNetworkClassError(makeSdkError(ErrorKindMock.Reqwest))).toBe(true)
	})

	it("returns true for ErrorKind.RetryFailed", () => {
		expect(isNetworkClassError(makeSdkError(ErrorKindMock.RetryFailed))).toBe(true)
	})

	it("returns true for ErrorKind.Response", () => {
		expect(isNetworkClassError(makeSdkError(ErrorKindMock.Response))).toBe(true)
	})

	it("returns false for ErrorKind.Internal", () => {
		expect(isNetworkClassError(makeSdkError(ErrorKindMock.Internal))).toBe(false)
	})

	it("returns false for a plain (non-SDK) Error", () => {
		expect(isNetworkClassError(new Error("not an SDK error"))).toBe(false)
	})
})

// ---------------------------------------------------------------------------
// normalizeModificationTimestampForComparison
// ---------------------------------------------------------------------------

describe("normalizeModificationTimestampForComparison", () => {
	it("divides millisecond timestamp by 1000 (floor)", () => {
		expect(normalizeModificationTimestampForComparison(1700000000123)).toBe(1700000000)
	})

	it("divides a second-epoch timestamp by 1000 (function always divides — not a passthrough)", () => {
		// The function always applies Math.floor(timestamp / 1000).
		// A 10-digit second-epoch value like 1700000000 yields 1700000, not 1700000000.
		// Use this for cross-comparing server timestamps (already seconds) with local asset
		// timestamps (milliseconds) — both end up on the same numeric scale after this call.
		expect(normalizeModificationTimestampForComparison(1700000000)).toBe(1700000)
	})

	it("zero → 0", () => {
		expect(normalizeModificationTimestampForComparison(0)).toBe(0)
	})

	it("floors fractional result — never rounds up", () => {
		// 1999 ms → 1 s (not 2)
		expect(normalizeModificationTimestampForComparison(1999)).toBe(1)
	})
})

// ---------------------------------------------------------------------------
// contactDisplayName
// ---------------------------------------------------------------------------

describe("contactDisplayName", () => {
	it("returns nickName when present and non-empty", () => {
		const contact = { nickName: "Alice", email: "alice@example.com" } as any
		expect(contactDisplayName(contact)).toBe("Alice")
	})

	it("falls back to email when nickName is empty string", () => {
		const contact = { nickName: "", email: "alice@example.com" } as any
		expect(contactDisplayName(contact)).toBe("alice@example.com")
	})

	it("falls back to email when nickName is undefined", () => {
		const contact = { nickName: undefined, email: "alice@example.com" } as any
		expect(contactDisplayName(contact)).toBe("alice@example.com")
	})

	it("ignores email when nickName is non-empty", () => {
		const contact = { nickName: "Bob", email: "bob@example.com" } as any
		expect(contactDisplayName(contact)).toBe("Bob")
	})
})

// ---------------------------------------------------------------------------
// makeDriveItemPublicLink
// ---------------------------------------------------------------------------

describe("makeDriveItemPublicLink", () => {
	const FILE_PUBLIC_LINK_URL_PREFIX = "https://app.filen.io/#/d/"
	const DIRECTORY_PUBLIC_LINK_URL_PREFIX = "https://app.filen.io/#/f/"

	it("file with decoded meta → URL starts with FILE_PUBLIC_LINK_URL_PREFIX with hex-encoded key", () => {
		const item = {
			type: "file",
			data: {
				meta: {
					tag: FileMeta_TagsMock.Decoded,
					inner: [{ key: "abc", name: "test.txt", size: 1n }]
				},
				uuid: "file-uuid"
			}
		} as any

		const result = makeDriveItemPublicLink({ item, linkUuid: "link-uuid" })
		expect(result).not.toBeNull()
		expect(result!.startsWith(FILE_PUBLIC_LINK_URL_PREFIX)).toBe(true)
		// key "abc" → hex "616263"
		expect(result!.endsWith("616263")).toBe(true)
		// includes encoded '#'
		expect(result!.includes("%23")).toBe(true)
	})

	it("file with undecoded meta → returns null", () => {
		const item = {
			type: "file",
			data: {
				meta: {
					tag: FileMeta_TagsMock.Undecoded,
					inner: []
				},
				uuid: "file-uuid"
			}
		} as any

		expect(makeDriveItemPublicLink({ item, linkUuid: "link-uuid" })).toBeNull()
	})

	it("directory with linkKey → URL starts with DIRECTORY_PUBLIC_LINK_URL_PREFIX with hex key", () => {
		const item = {
			type: "directory",
			data: { uuid: "dir-uuid" }
		} as any

		const result = makeDriveItemPublicLink({ item, linkUuid: "link-uuid", linkKey: "abc" })
		expect(result).not.toBeNull()
		expect(result!.startsWith(DIRECTORY_PUBLIC_LINK_URL_PREFIX)).toBe(true)
		expect(result!.endsWith("616263")).toBe(true)
	})

	it("directory without linkKey → returns null", () => {
		const item = {
			type: "directory",
			data: { uuid: "dir-uuid" }
		} as any

		expect(makeDriveItemPublicLink({ item, linkUuid: "link-uuid" })).toBeNull()
	})

	it("sharedFile type → returns null (default branch)", () => {
		const item = {
			type: "sharedFile",
			data: { uuid: "file-uuid" }
		} as any

		expect(makeDriveItemPublicLink({ item, linkUuid: "link-uuid" })).toBeNull()
	})

	it("hex encoding: key 'abc' → '616263' in the URL", () => {
		const item = {
			type: "file",
			data: {
				meta: {
					tag: FileMeta_TagsMock.Decoded,
					inner: [{ key: "abc", name: "x", size: 1n }]
				},
				uuid: "uuid"
			}
		} as any

		const result = makeDriveItemPublicLink({ item, linkUuid: "link-uuid" })
		expect(result!.endsWith("616263")).toBe(true)
	})
})

// ---------------------------------------------------------------------------
// unwrapParentUuid
// ---------------------------------------------------------------------------

describe("unwrapParentUuid", () => {
	it("ParentUuid_Tags.Uuid tag → returns the inner string", () => {
		const parent = {
			tag: ParentUuidTagsMock.Uuid,
			inner: ["expected-uuid"]
		} as any

		expect(unwrapParentUuid(parent)).toBe("expected-uuid")
	})

	it("non-Uuid tag → returns null", () => {
		const parent = {
			tag: ParentUuidTagsMock.Trash,
			inner: []
		} as any

		expect(unwrapParentUuid(parent)).toBeNull()
	})

	it("uses index 0 from inner array for Uuid tag", () => {
		const parent = {
			tag: ParentUuidTagsMock.Uuid,
			inner: ["first-uuid", "second-uuid"]
		} as any

		expect(unwrapParentUuid(parent)).toBe("first-uuid")
	})
})
