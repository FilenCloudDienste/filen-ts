import { vi, describe, it, expect, beforeEach } from "vitest"

// Minimal mock for @filen/sdk-rs — only AnyFile classes are needed here
vi.mock("@filen/sdk-rs", () => {
	class TaggedUnion {
		tag: string
		inner: unknown[]
		constructor(tag: string, value: unknown) {
			this.tag = tag
			this.inner = [value]
		}
	}

	return {
		AnyFile: {
			File: class extends TaggedUnion {
				constructor(file: unknown) {
					super("File", file)
				}
			},
			Shared: class extends TaggedUnion {
				constructor(file: unknown) {
					super("Shared", file)
				}
			}
		}
	}
})

vi.mock("expo-file-system", async () => await import("@/tests/mocks/expoFileSystem"))

vi.mock("react-native", async () => await import("@/tests/mocks/reactNative"))

// Mock storageRoots — use the mock Directory from the already-mocked expo-file-system
vi.mock("@/lib/storageRoots", async () => {
	const efs = await import("@/tests/mocks/expoFileSystem")
	return {
		THUMBNAILS_DIRECTORY: new efs.Directory("file:///shared/group.io.filen.app/thumbnails/v2")
	}
})

// Mock the http store — only used by waitForHttpProvider, not the pure helpers
const mockHttpStoreState: { port: number | null; getFileUrl: ((file: unknown) => string) | null } = {
	port: null,
	getFileUrl: null
}

vi.mock("@/stores/useHttp.store", () => ({
	default: {
		getState: () => mockHttpStoreState,
		subscribe: vi.fn(() => vi.fn())
	}
}))

import {
	abortError,
	isAbortError,
	OfflineAbortError,
	getPath,
	ensureDirectory,
	driveItemToAnyFile,
	getThumbnailKind
} from "@/lib/thumbnailsHelpers"
import { AnyFile } from "@filen/sdk-rs"
import { fs } from "@/tests/mocks/expoFileSystem"

const THUMBNAILS_DIR = "file:///shared/group.io.filen.app/thumbnails/v2"

beforeEach(() => {
	fs.clear()
	vi.clearAllMocks()
})

// ---------------------------------------------------------------------------
// abortError — item #12
// Branch 1: signal.reason instanceof Error  → return that Error as-is
// Branch 2: reason is non-null/non-undefined but not an Error → new Error(String(reason))
// Branch 3: reason is undefined/null / no signal → new Error('Aborted')
// ---------------------------------------------------------------------------

describe("abortError", () => {
	it("returns the exact Error instance when signal.reason is already an Error", () => {
		const reason = new Error("original message")
		const signal = { reason } as AbortSignal

		const result = abortError(signal)

		expect(result).toBe(reason)
		expect(result.message).toBe("original message")
	})

	it("wraps a string reason in a new Error whose message is the string", () => {
		const signal = { reason: "string reason" } as unknown as AbortSignal

		const result = abortError(signal)

		expect(result).toBeInstanceOf(Error)
		expect(result.message).toBe("string reason")
	})

	it("wraps a numeric reason via String() — message is '42'", () => {
		const signal = { reason: 42 } as unknown as AbortSignal

		const result = abortError(signal)

		expect(result).toBeInstanceOf(Error)
		expect(result.message).toBe("42")
	})

	it("wraps a plain-object reason via String() — message is '[object Object]'", () => {
		const signal = { reason: { code: 1 } } as unknown as AbortSignal

		const result = abortError(signal)

		expect(result).toBeInstanceOf(Error)
		expect(result.message).toBe("[object Object]")
	})

	it("returns Error('Aborted') when signal.reason is null", () => {
		const signal = { reason: null } as unknown as AbortSignal

		const result = abortError(signal)

		expect(result).toBeInstanceOf(Error)
		expect(result.message).toBe("Aborted")
	})

	it("returns Error('Aborted') when signal.reason is undefined", () => {
		const signal = { reason: undefined } as unknown as AbortSignal

		const result = abortError(signal)

		expect(result).toBeInstanceOf(Error)
		expect(result.message).toBe("Aborted")
	})

	it("returns Error('Aborted') when no signal is passed", () => {
		const result = abortError(undefined)

		expect(result).toBeInstanceOf(Error)
		expect(result.message).toBe("Aborted")
	})

	it("returns Error('Aborted') when called with no arguments", () => {
		const result = abortError()

		expect(result).toBeInstanceOf(Error)
		expect(result.message).toBe("Aborted")
	})
})

// ---------------------------------------------------------------------------
// OfflineAbortError
// ---------------------------------------------------------------------------

describe("OfflineAbortError", () => {
	it("is an instance of Error", () => {
		const err = new OfflineAbortError()

		expect(err).toBeInstanceOf(Error)
	})

	it("has message 'Offline'", () => {
		const err = new OfflineAbortError()

		expect(err.message).toBe("Offline")
	})

	it("has name 'OfflineAbortError'", () => {
		const err = new OfflineAbortError()

		expect(err.name).toBe("OfflineAbortError")
	})
})

// ---------------------------------------------------------------------------
// getPath — pure path computation from uuid
// ---------------------------------------------------------------------------

describe("getPath", () => {
	it("returns a webp path under the thumbnails directory keyed by uuid", () => {
		const item = {
			type: "file" as const,
			data: { uuid: "abc-123", size: 1024n, decryptedMeta: { name: "photo.jpg" } }
		}

		const result = getPath(item as any)

		expect(result).toBe(`${THUMBNAILS_DIR}/abc-123.webp`)
	})

	it("uses the item uuid regardless of item type", () => {
		const item = {
			type: "sharedFile" as const,
			data: { uuid: "shared-uuid", size: 512n, decryptedMeta: { name: "doc.pdf" } }
		}

		const result = getPath(item as any)

		expect(result).toBe(`${THUMBNAILS_DIR}/shared-uuid.webp`)
	})
})

// ---------------------------------------------------------------------------
// ensureDirectory — creates the thumbnail directory when it does not exist
// ---------------------------------------------------------------------------

describe("ensureDirectory", () => {
	it("creates the thumbnails directory when it does not exist", () => {
		// Confirm not present initially
		expect(fs.has(THUMBNAILS_DIR)).toBe(false)

		ensureDirectory()

		// Directory should now exist in the in-memory fs
		expect(fs.get(THUMBNAILS_DIR)).toBe("dir")
	})

	it("is idempotent — calling it twice does not throw", () => {
		ensureDirectory()
		expect(() => {
			ensureDirectory()
		}).not.toThrow()
	})
})

// ---------------------------------------------------------------------------
// driveItemToAnyFile — switch on item.type
// ---------------------------------------------------------------------------

describe("driveItemToAnyFile", () => {
	it("returns AnyFile.File for type='file'", () => {
		const data = { uuid: "file-uuid", size: 100n, decryptedMeta: { name: "x.jpg" } }
		const item = { type: "file" as const, data }

		const result = driveItemToAnyFile(item as any)

		expect(result).not.toBeNull()
		expect(result).toBeInstanceOf((AnyFile as any).File)
		// The inner[0] should be the data object
		expect((result as any).inner[0]).toBe(data)
	})

	it("returns AnyFile.Shared for type='sharedFile'", () => {
		const data = { uuid: "shared-uuid", size: 200n, decryptedMeta: { name: "y.jpg" } }
		const item = { type: "sharedFile" as const, data }

		const result = driveItemToAnyFile(item as any)

		expect(result).not.toBeNull()
		expect(result).toBeInstanceOf((AnyFile as any).Shared)
		expect((result as any).inner[0]).toBe(data)
	})

	it("returns AnyFile.Shared for type='sharedRootFile'", () => {
		const data = { uuid: "root-shared-uuid", size: 300n, decryptedMeta: { name: "z.jpg" } }
		const item = { type: "sharedRootFile" as const, data }

		const result = driveItemToAnyFile(item as any)

		expect(result).not.toBeNull()
		expect(result).toBeInstanceOf((AnyFile as any).Shared)
		expect((result as any).inner[0]).toBe(data)
	})

	it("returns null for type='directory'", () => {
		const item = {
			type: "directory" as const,
			data: { uuid: "dir-uuid", size: 0n, decryptedMeta: { name: "folder" } }
		}

		expect(driveItemToAnyFile(item as any)).toBeNull()
	})

	it("returns null for type='sharedDirectory'", () => {
		const item = {
			type: "sharedDirectory" as const,
			data: { uuid: "shared-dir-uuid", size: 0n, decryptedMeta: { name: "shared-folder" } }
		}

		expect(driveItemToAnyFile(item as any)).toBeNull()
	})

	it("returns null for type='sharedRootDirectory'", () => {
		const item = {
			type: "sharedRootDirectory" as const,
			data: { uuid: "root-dir-uuid", size: 0n, decryptedMeta: { name: "root-folder" } }
		}

		expect(driveItemToAnyFile(item as any)).toBeNull()
	})
})

// ---------------------------------------------------------------------------
// getThumbnailKind — displayability (getPreviewType) AND the SDK's own per-file gate
// (canMakeThumbnail, computed in Rust from decrypted name + mime). image | rawImage → "image"
// only when the SDK says it can; video → "video" regardless (the JS path). svg is NOT thumbnailable:
// resvg renders <text> and raster <image> as nothing.
// ---------------------------------------------------------------------------

describe("getThumbnailKind", () => {
	const fileItem = (
		name: string | undefined,
		canMakeThumbnail: boolean = true,
		type: "file" | "sharedFile" | "sharedRootFile" = "file"
	) =>
		({
			type,
			data: {
				uuid: "u",
				size: 1n,
				canMakeThumbnail,
				decryptedMeta: name === undefined ? null : { name }
			}
		}) as never

	it("maps expo-image formats and RAW to the image path when the SDK gate is open", () => {
		expect(getThumbnailKind(fileItem("photo.jpg"))).toBe("image")
		expect(getThumbnailKind(fileItem("shot.cr2"))).toBe("image")
		expect(getThumbnailKind(fileItem("shot.avif", true, "sharedFile"))).toBe("image")
		expect(getThumbnailKind(fileItem("shot.png", true, "sharedRootFile"))).toBe("image")
	})

	it("vetoes an image the SDK says it cannot thumbnail (a listed .ico, a .jxl, a .cr2 it does not decode)", () => {
		expect(getThumbnailKind(fileItem("favicon.ico", false))).toBeNull()
		expect(getThumbnailKind(fileItem("photo.jpg", false))).toBeNull()
		expect(getThumbnailKind(fileItem("shot.cr2", false))).toBeNull()
	})

	it("maps video to the JS path regardless of the SDK flag", () => {
		expect(getThumbnailKind(fileItem("clip.mp4", false))).toBe("video")
		expect(getThumbnailKind(fileItem("clip.mp4", true))).toBe("video")
	})

	it("is null for svg (a transparent tile is worse than the icon)", () => {
		expect(getThumbnailKind(fileItem("logo.svg", true))).toBeNull()
	})

	it("is null for non-previewable files, directories and undecrypted names", () => {
		expect(getThumbnailKind(fileItem("doc.pdf"))).toBeNull()
		expect(getThumbnailKind(fileItem("archive.zip"))).toBeNull()
		expect(getThumbnailKind(fileItem(undefined))).toBeNull()
		expect(
			getThumbnailKind({ type: "directory", data: { uuid: "d", size: 0n, decryptedMeta: { name: "photos.jpg" } } } as never)
		).toBeNull()
	})
})

describe("isAbortError", () => {
	it("recognises the uniffi bindings' AbortError by name (never by instanceof)", () => {
		expect(isAbortError({ name: "AbortError", message: "A Rust future was aborted" })).toBe(true)
	})

	it("recognises a DOM AbortSignal reason (name AbortError)", () => {
		const controller = new AbortController()

		controller.abort()

		expect(isAbortError(controller.signal.reason)).toBe(true)
	})

	it("is false for other errors and non-errors", () => {
		expect(isAbortError(new Error("network"))).toBe(false)
		expect(isAbortError("AbortError")).toBe(false)
		expect(isAbortError(null)).toBe(false)
		expect(isAbortError(undefined)).toBe(false)
	})
})
