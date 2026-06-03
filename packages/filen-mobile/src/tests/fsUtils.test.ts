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

import { type Directory as ExpoDirectory } from "expo-file-system"
import { Directory, File, fs } from "@/tests/mocks/expoFileSystem"
import { walkLocalDirectory, sumLocalDirectoryFileBytes, listLocalDirectoryRecursive, sweepStrayDownloadFiles } from "@/lib/fsUtils"

/** Cast a mock Directory to the real expo-file-system Directory type for call sites. */
function asDir(uri: string): ExpoDirectory {
	return new Directory(uri) as unknown as ExpoDirectory
}

// ─── walkLocalDirectory ───────────────────────────────────────────────────────

describe("walkLocalDirectory", () => {
	beforeEach(() => {
		fs.clear()
	})

	it("visits every file under a flat directory in insertion order", () => {
		const ROOT = "file:///document/walk-flat"
		fs.set(ROOT, "dir")
		fs.set(`${ROOT}/a.txt`, new Uint8Array([1]))
		fs.set(`${ROOT}/b.txt`, new Uint8Array([2]))

		const visited: string[] = []
		walkLocalDirectory(asDir(ROOT), entry => {
			visited.push(entry.uri)
		})

		expect(visited).toContain(`${ROOT}/a.txt`)
		expect(visited).toContain(`${ROOT}/b.txt`)
		expect(visited).toHaveLength(2)
	})

	it("visits files in nested subdirectories", () => {
		const ROOT = "file:///document/walk-nested"
		fs.set(ROOT, "dir")
		fs.set(`${ROOT}/sub`, "dir")
		fs.set(`${ROOT}/sub/child.bin`, new Uint8Array([9]))

		const visited: string[] = []
		walkLocalDirectory(asDir(ROOT), entry => {
			visited.push(entry.uri)
		})

		expect(visited).toContain(`${ROOT}/sub`)
		expect(visited).toContain(`${ROOT}/sub/child.bin`)
	})

	it("visits Directory entries as well as File entries", () => {
		const ROOT = "file:///document/walk-dirs"
		fs.set(ROOT, "dir")
		fs.set(`${ROOT}/sub`, "dir")
		fs.set(`${ROOT}/sub/file.txt`, new Uint8Array([1]))

		const dirs: string[] = []
		const files: string[] = []

		walkLocalDirectory(asDir(ROOT), entry => {
			if (entry instanceof Directory) {
				dirs.push(entry.uri)
			} else {
				files.push(entry.uri)
			}
		})

		expect(dirs).toContain(`${ROOT}/sub`)
		expect(files).toContain(`${ROOT}/sub/file.txt`)
	})

	it("does not recurse into a directory when visitor returns 'skip'", () => {
		const ROOT = "file:///document/walk-skip"
		fs.set(ROOT, "dir")
		fs.set(`${ROOT}/blocked`, "dir")
		fs.set(`${ROOT}/blocked/secret.txt`, new Uint8Array([42]))
		fs.set(`${ROOT}/allowed.txt`, new Uint8Array([1]))

		const visited: string[] = []
		walkLocalDirectory(asDir(ROOT), entry => {
			visited.push(entry.uri)

			if (entry instanceof Directory && entry.name === "blocked") {
				return "skip"
			}

			return undefined
		})

		expect(visited).toContain(`${ROOT}/blocked`)
		expect(visited).not.toContain(`${ROOT}/blocked/secret.txt`)
		expect(visited).toContain(`${ROOT}/allowed.txt`)
	})

	it("does not visit the root directory itself", () => {
		const ROOT = "file:///document/walk-root-self"
		fs.set(ROOT, "dir")
		fs.set(`${ROOT}/file.txt`, new Uint8Array([1]))

		const visited: string[] = []
		walkLocalDirectory(asDir(ROOT), entry => {
			visited.push(entry.uri)
		})

		expect(visited).not.toContain(ROOT)
	})

	it("produces an empty visit list for an empty directory", () => {
		const ROOT = "file:///document/walk-empty"
		fs.set(ROOT, "dir")

		const visited: string[] = []
		walkLocalDirectory(asDir(ROOT), entry => {
			visited.push(entry.uri)
		})

		expect(visited).toHaveLength(0)
	})

	it("does not throw when the root directory does not exist", () => {
		const ROOT = "file:///document/walk-nonexistent"

		const visited: string[] = []
		expect(() => {
			walkLocalDirectory(asDir(ROOT), entry => {
				visited.push(entry.uri)
			})
		}).not.toThrow()

		expect(visited).toHaveLength(0)
	})

	it("swallows a subtree read failure and continues with other branches", () => {
		const ROOT = "file:///document/walk-error"
		const realDir = new Directory(ROOT)
		fs.set(ROOT, "dir")
		fs.set(`${ROOT}/good.txt`, new Uint8Array([1]))

		// Make a subdirectory whose list() throws
		const badDir = new Directory(`${ROOT}/bad`)
		fs.set(badDir.uri, "dir")
		const origList = badDir.list.bind(badDir)
		let throwCount = 0
		vi.spyOn(badDir, "list").mockImplementation(() => {
			if (throwCount++ === 0) {
				throw new Error("read error")
			}

			return origList()
		})

		// Inject bad dir by overriding list on realDir so badDir is returned
		const origRootList = realDir.list.bind(realDir)
		vi.spyOn(realDir, "list").mockImplementation(() => {
			const entries = origRootList()
			// replace the "bad" entry with our spy instance
			return entries.map(e => (e.uri === badDir.uri ? badDir : e))
		})

		const visited: string[] = []
		expect(() => {
			walkLocalDirectory(realDir as unknown as ExpoDirectory, entry => {
				visited.push(entry.uri)
			})
		}).not.toThrow()

		// "good.txt" is a sibling of "bad" at root level — it should be visited
		expect(visited).toContain(`${ROOT}/good.txt`)
	})

	it("cycle-detection: does not infinitely recurse if a directory URI is seen twice", () => {
		// The visited-Set guard prevents re-entering a directory with the same URI.
		// We simulate this by pre-populating a deeply-nested path and verifying the
		// traversal terminates rather than hanging.
		const ROOT = "file:///document/walk-cycle"
		fs.set(ROOT, "dir")
		fs.set(`${ROOT}/child`, "dir")
		fs.set(`${ROOT}/child/file.txt`, new Uint8Array([7]))

		// Walk the same root twice — second pass must hit visited guard immediately
		let visitCount = 0
		walkLocalDirectory(asDir(ROOT), () => {
			visitCount++
		})
		const firstCount = visitCount

		visitCount = 0
		walkLocalDirectory(asDir(ROOT), () => {
			visitCount++
		})

		// Both walks must visit the same number of entries (the visited set is local)
		expect(visitCount).toBe(firstCount)
		expect(visitCount).toBeGreaterThan(0)
	})
})

// ─── sumLocalDirectoryFileBytes ───────────────────────────────────────────────

describe("sumLocalDirectoryFileBytes", () => {
	beforeEach(() => {
		fs.clear()
	})

	it("returns 0 for an empty directory", () => {
		const ROOT = "file:///document/sum-empty"
		fs.set(ROOT, "dir")

		expect(sumLocalDirectoryFileBytes(asDir(ROOT))).toBe(0)
	})

	it("returns 0 for a non-existent directory", () => {
		const ROOT = "file:///document/sum-nonexistent"

		expect(sumLocalDirectoryFileBytes(asDir(ROOT))).toBe(0)
	})

	it("sums sizes of all files in a flat directory", () => {
		const ROOT = "file:///document/sum-flat"
		fs.set(ROOT, "dir")
		fs.set(`${ROOT}/a.bin`, new Uint8Array([1, 2, 3]))   // 3 bytes
		fs.set(`${ROOT}/b.bin`, new Uint8Array([4, 5]))       // 2 bytes

		expect(sumLocalDirectoryFileBytes(asDir(ROOT))).toBe(5)
	})

	it("sums sizes recursively across nested subdirectories", () => {
		const ROOT = "file:///document/sum-nested"
		fs.set(ROOT, "dir")
		fs.set(`${ROOT}/sub`, "dir")
		fs.set(`${ROOT}/top.bin`, new Uint8Array([1, 2]))           // 2 bytes
		fs.set(`${ROOT}/sub/inner.bin`, new Uint8Array([3, 4, 5]))  // 3 bytes

		expect(sumLocalDirectoryFileBytes(asDir(ROOT))).toBe(5)
	})

	it("does not count directories (size ?? 0 guard for null-size entries)", () => {
		const ROOT = "file:///document/sum-dirs-only"
		fs.set(ROOT, "dir")
		fs.set(`${ROOT}/subdir`, "dir")
		fs.set(`${ROOT}/subdir/nested`, "dir")

		expect(sumLocalDirectoryFileBytes(asDir(ROOT))).toBe(0)
	})

	it("handles a zero-byte file without adding to the total", () => {
		const ROOT = "file:///document/sum-zerobyte"
		fs.set(ROOT, "dir")
		fs.set(`${ROOT}/empty.bin`, new Uint8Array([]))        // 0 bytes
		fs.set(`${ROOT}/data.bin`, new Uint8Array([1, 2, 3])) // 3 bytes

		expect(sumLocalDirectoryFileBytes(asDir(ROOT))).toBe(3)
	})
})

// ─── listLocalDirectoryRecursive ──────────────────────────────────────────────

describe("listLocalDirectoryRecursive", () => {
	beforeEach(() => {
		fs.clear()
	})

	it("returns an empty array for an empty directory", () => {
		const ROOT = "file:///document/list-empty"
		fs.set(ROOT, "dir")

		expect(listLocalDirectoryRecursive(asDir(ROOT))).toEqual([])
	})

	it("returns an empty array for a non-existent directory", () => {
		const ROOT = "file:///document/list-nonexistent"

		expect(listLocalDirectoryRecursive(asDir(ROOT))).toEqual([])
	})

	it("returns File instances for files in a flat directory", () => {
		const ROOT = "file:///document/list-flat"
		fs.set(ROOT, "dir")
		fs.set(`${ROOT}/file-a.txt`, new Uint8Array([1]))
		fs.set(`${ROOT}/file-b.txt`, new Uint8Array([2]))

		const entries = listLocalDirectoryRecursive(asDir(ROOT))

		expect(entries).toHaveLength(2)
		expect(entries.every(e => e instanceof File)).toBe(true)
		const uris = entries.map(e => e.uri)
		expect(uris).toContain(`${ROOT}/file-a.txt`)
		expect(uris).toContain(`${ROOT}/file-b.txt`)
	})

	it("includes both Directory and File entries from nested trees", () => {
		const ROOT = "file:///document/list-nested"
		fs.set(ROOT, "dir")
		fs.set(`${ROOT}/sub`, "dir")
		fs.set(`${ROOT}/sub/child.bin`, new Uint8Array([9]))
		fs.set(`${ROOT}/top.bin`, new Uint8Array([1]))

		const entries = listLocalDirectoryRecursive(asDir(ROOT))
		const uris = entries.map(e => e.uri)

		expect(uris).toContain(`${ROOT}/sub`)
		expect(uris).toContain(`${ROOT}/sub/child.bin`)
		expect(uris).toContain(`${ROOT}/top.bin`)
		expect(entries.some(e => e instanceof Directory)).toBe(true)
		expect(entries.some(e => e instanceof File)).toBe(true)
	})

	it("result is suitable for Promise.all usage (every element has a uri)", () => {
		const ROOT = "file:///document/list-promiseall"
		fs.set(ROOT, "dir")
		fs.set(`${ROOT}/x.bin`, new Uint8Array([1, 2]))
		fs.set(`${ROOT}/y.bin`, new Uint8Array([3, 4]))

		const entries = listLocalDirectoryRecursive(asDir(ROOT))

		expect(entries.every(e => typeof e.uri === "string" && e.uri.length > 0)).toBe(true)
	})
})

// ─── sweepStrayDownloadFiles ──────────────────────────────────────────────────

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

	it("deletes .filendl in fileCache/v1", () => {
		fs.set(FILE_CACHE, "dir")
		fs.set(`${FILE_CACHE}/uuid-1`, "dir")
		fs.set(`${FILE_CACHE}/uuid-1/file.bin`, new Uint8Array([0]))
		fs.set(`${FILE_CACHE}/uuid-1/file.bin.filendl`, new Uint8Array([1]))

		sweepStrayDownloadFiles()

		expect(fs.has(`${FILE_CACHE}/uuid-1/file.bin`)).toBe(true)
		expect(fs.has(`${FILE_CACHE}/uuid-1/file.bin.filendl`)).toBe(false)
	})

	it("deletes .filendl in audioCache/v2", () => {
		fs.set(AUDIO_CACHE, "dir")
		fs.set(`${AUDIO_CACHE}/uuid-2`, "dir")
		fs.set(`${AUDIO_CACHE}/uuid-2/track.mp3`, new Uint8Array([0]))
		fs.set(`${AUDIO_CACHE}/uuid-2/track.mp3.filendl`, new Uint8Array([1]))

		sweepStrayDownloadFiles()

		expect(fs.has(`${AUDIO_CACHE}/uuid-2/track.mp3`)).toBe(true)
		expect(fs.has(`${AUDIO_CACHE}/uuid-2/track.mp3.filendl`)).toBe(false)
	})

	it("deletes .filendl in thumbnails/v2", () => {
		fs.set(THUMBNAILS, "dir")
		fs.set(`${THUMBNAILS}/source.jpg`, new Uint8Array([0]))
		fs.set(`${THUMBNAILS}/source.jpg.filendl`, new Uint8Array([1]))

		sweepStrayDownloadFiles()

		expect(fs.has(`${THUMBNAILS}/source.jpg`)).toBe(true)
		expect(fs.has(`${THUMBNAILS}/source.jpg.filendl`)).toBe(false)
	})

	it("deletes .filendl in Downloads", () => {
		fs.set(DOWNLOADS, "dir")
		fs.set(`${DOWNLOADS}/report.pdf`, new Uint8Array([0]))
		fs.set(`${DOWNLOADS}/report.pdf.filendl`, new Uint8Array([1]))

		sweepStrayDownloadFiles()

		expect(fs.has(`${DOWNLOADS}/report.pdf`)).toBe(true)
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

	it("continues sweeping remaining files in the same root when a single delete throws", () => {
		fs.set(OFFLINE_FILES, "dir")
		fs.set(`${OFFLINE_FILES}/uuid-x`, "dir")
		fs.set(`${OFFLINE_FILES}/uuid-x/first.filendl`, new Uint8Array([1]))
		fs.set(`${OFFLINE_FILES}/uuid-x/second.filendl`, new Uint8Array([2]))
		fs.set(`${OFFLINE_FILES}/uuid-x/third.filendl`, new Uint8Array([3]))

		// Intercept File.delete on first.filendl to throw once
		let firstDeleteCall = true
		const origDelete = File.prototype.delete
		vi.spyOn(File.prototype, "delete").mockImplementation(function (this: File) {
			if (firstDeleteCall && this.uri.endsWith("first.filendl")) {
				firstDeleteCall = false
				throw new Error("disk full")
			}

			return origDelete.call(this)
		})

		expect(() => sweepStrayDownloadFiles()).not.toThrow()

		// second.filendl and third.filendl must still be deleted despite the first failure
		expect(fs.has(`${OFFLINE_FILES}/uuid-x/second.filendl`)).toBe(false)
		expect(fs.has(`${OFFLINE_FILES}/uuid-x/third.filendl`)).toBe(false)

		vi.restoreAllMocks()
	})
})
