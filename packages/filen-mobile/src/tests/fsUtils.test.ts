import { vi, describe, it, expect, beforeEach } from "vitest"

vi.mock("expo-file-system", async () => await import("@/tests/mocks/expoFileSystem"))

vi.mock("react-native", () => ({
	Platform: { OS: "android", select: <T,>(specifics: { ios?: T; default: T }) => specifics.default }
}))

vi.mock("@/constants", () => ({
	IOS_APP_GROUP_IDENTIFIER: "group.io.filen.app"
}))

// Hoisted so vi.mock factory below can reference them — vi.mock is moved
// above all const declarations during test transform.
const { OFFLINE_FILES, OFFLINE_DIRS, FILE_CACHE, AUDIO_CACHE, THUMBNAILS, DOWNLOADS } = vi.hoisted(() => {
	const BASE = "file:///document"
	return {
		OFFLINE_FILES: `${BASE}/offline/v1/files`,
		OFFLINE_DIRS: `${BASE}/offline/v1/directories`,
		FILE_CACHE: `${BASE}/fileCache/v1`,
		AUDIO_CACHE: `${BASE}/audioCache/v2`,
		THUMBNAILS: `${BASE}/thumbnails/v2`,
		DOWNLOADS: `${BASE}/Downloads`
	}
})

// fsUtils reads the Directory constants from storageRoots. Mocking that one
// file is enough — it sidesteps the heavy modules (offline/fileCache/
// audioCache/thumbnails) and their native deps (SDK, expo-image, expo-video).
vi.mock("@/lib/storageRoots", async () => {
	const { Directory } = await import("@/tests/mocks/expoFileSystem")
	return {
		OFFLINE_FILES_DIRECTORY: new Directory(OFFLINE_FILES),
		OFFLINE_DIRECTORIES_DIRECTORY: new Directory(OFFLINE_DIRS),
		FILE_CACHE_PARENT_DIRECTORY: new Directory(FILE_CACHE),
		AUDIO_CACHE_PARENT_DIRECTORY: new Directory(AUDIO_CACHE),
		THUMBNAILS_DIRECTORY: new Directory(THUMBNAILS)
	}
})

import { fs } from "@/tests/mocks/expoFileSystem"
import { sweepStrayDownloadFiles } from "@/lib/fsUtils"

describe("sweepStrayDownloadFiles", () => {
	beforeEach(() => {
		fs.clear()
	})

	it("deletes .filendl files in offline/v1/files/{uuid}/", () => {
		fs.set(OFFLINE_FILES, "dir")
		fs.set(`${OFFLINE_FILES}/uuid-a`, "dir")
		fs.set(`${OFFLINE_FILES}/uuid-a/document.pdf`, new Uint8Array([1, 2, 3]))
		fs.set(`${OFFLINE_FILES}/uuid-a/document.pdf.filendl`, new Uint8Array([4, 5]))

		sweepStrayDownloadFiles()

		expect(fs.has(`${OFFLINE_FILES}/uuid-a/document.pdf`)).toBe(true)
		expect(fs.has(`${OFFLINE_FILES}/uuid-a/document.pdf.filendl`)).toBe(false)
	})

	it("recurses into offline/v1/directories/ subtrees and deletes nested .filendl", () => {
		fs.set(OFFLINE_DIRS, "dir")
		fs.set(`${OFFLINE_DIRS}/uuid-a`, "dir")
		fs.set(`${OFFLINE_DIRS}/uuid-a/sub`, "dir")
		fs.set(`${OFFLINE_DIRS}/uuid-a/sub/child.bin`, new Uint8Array([1]))
		fs.set(`${OFFLINE_DIRS}/uuid-a/sub/child.bin.filendl`, new Uint8Array([2]))

		sweepStrayDownloadFiles()

		expect(fs.has(`${OFFLINE_DIRS}/uuid-a/sub/child.bin`)).toBe(true)
		expect(fs.has(`${OFFLINE_DIRS}/uuid-a/sub/child.bin.filendl`)).toBe(false)
	})

	it("deletes .filendl in fileCache/v1, audioCache/v2, thumbnails/v2, and Downloads", () => {
		fs.set(FILE_CACHE, "dir")
		fs.set(`${FILE_CACHE}/uuid-1`, "dir")
		fs.set(`${FILE_CACHE}/uuid-1/file.bin.filendl`, new Uint8Array([1]))

		fs.set(AUDIO_CACHE, "dir")
		fs.set(`${AUDIO_CACHE}/uuid-2`, "dir")
		fs.set(`${AUDIO_CACHE}/uuid-2/track.mp3.filendl`, new Uint8Array([1]))

		fs.set(THUMBNAILS, "dir")
		fs.set(`${THUMBNAILS}/source.jpg.filendl`, new Uint8Array([1]))

		fs.set(DOWNLOADS, "dir")
		fs.set(`${DOWNLOADS}/report.pdf.filendl`, new Uint8Array([1]))

		sweepStrayDownloadFiles()

		expect(fs.has(`${FILE_CACHE}/uuid-1/file.bin.filendl`)).toBe(false)
		expect(fs.has(`${AUDIO_CACHE}/uuid-2/track.mp3.filendl`)).toBe(false)
		expect(fs.has(`${THUMBNAILS}/source.jpg.filendl`)).toBe(false)
		expect(fs.has(`${DOWNLOADS}/report.pdf.filendl`)).toBe(false)
	})

	it("does not touch non-.filendl files even if name contains 'filendl'", () => {
		fs.set(OFFLINE_FILES, "dir")
		fs.set(`${OFFLINE_FILES}/uuid-a`, "dir")
		fs.set(`${OFFLINE_FILES}/uuid-a/filendl-report.pdf`, new Uint8Array([1]))
		fs.set(`${OFFLINE_FILES}/uuid-a/my.filendl.txt`, new Uint8Array([1]))

		sweepStrayDownloadFiles()

		expect(fs.has(`${OFFLINE_FILES}/uuid-a/filendl-report.pdf`)).toBe(true)
		expect(fs.has(`${OFFLINE_FILES}/uuid-a/my.filendl.txt`)).toBe(true)
	})

	it("is a no-op when none of the roots exist", () => {
		expect(() => sweepStrayDownloadFiles()).not.toThrow()
	})

	it("continues sweeping other roots when one root is missing", () => {
		fs.set(OFFLINE_FILES, "dir")
		fs.set(`${OFFLINE_FILES}/uuid-a`, "dir")
		fs.set(`${OFFLINE_FILES}/uuid-a/file.bin.filendl`, new Uint8Array([1]))
		// fileCache / audioCache / thumbnails / Downloads roots NOT created

		sweepStrayDownloadFiles()

		expect(fs.has(`${OFFLINE_FILES}/uuid-a/file.bin.filendl`)).toBe(false)
	})
})
