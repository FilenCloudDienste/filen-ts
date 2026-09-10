import { vi, describe, it, expect, beforeEach, afterEach } from "vitest"

// storageRoots.ts constructs module-level constants at import time, relying on
// Platform.OS and expo-file-system.  We test different platform branches by
// resetting modules and dynamically re-importing after patching the mocks.

vi.mock("expo-file-system", async () => await import("@/tests/mocks/expoFileSystem"))

// @/constants is node-safe — import the real one so IOS_APP_GROUP_IDENTIFIER is real.
vi.mock("@/constants", async () => await import("@/tests/mocks/constants"))

// react-native is globally aliased to the minimal mock — the mock exports a mutable
// Platform object so we can control Platform.OS per test.
vi.mock("react-native", async () => await import("@/tests/mocks/reactNative"))

// The version sweep warns on a failed removal — stub the sink so the assertions can read it.
vi.mock("@/lib/logger", async () => await import("@/tests/mocks/logger"))

beforeEach(() => {
	vi.resetModules()
})

async function importRoots(platform: "ios" | "android") {
	// Patch the mocked Platform.OS before importing storageRoots so the top-level
	// Platform.select() call sees the right value.
	const { Platform } = await import("react-native")
	Platform.OS = platform

	// Re-import after module reset so the constants are re-evaluated.
	return import("@/lib/storageRoots")
}

describe("BASE_DIRECTORY_URI derivation", () => {
	it("on Android: directory paths are rooted at FileSystem.Paths.document.uri", async () => {
		const { OFFLINE_DIRECTORY } = await importRoots("android")
		const { Paths } = await import("expo-file-system")

		expect(OFFLINE_DIRECTORY.uri).toContain(Paths.document.uri)
	})

	it("on iOS: directory paths are rooted at the iOS app group container", async () => {
		const { OFFLINE_DIRECTORY } = await importRoots("ios")
		const { IOS_APP_GROUP_IDENTIFIER } = await import("@/constants")

		// The mock appleSharedContainers proxy returns file:///shared/<groupId>
		expect(OFFLINE_DIRECTORY.uri).toContain(IOS_APP_GROUP_IDENTIFIER)
	})
})

describe("version segments embedded in paths", () => {
	it("OFFLINE_DIRECTORY.uri contains 'offline/v2' (OFFLINE_VERSION=2)", async () => {
		const { OFFLINE_DIRECTORY, OFFLINE_VERSION } = await importRoots("android")

		expect(OFFLINE_VERSION).toBe(2)
		expect(OFFLINE_DIRECTORY.uri).toContain(`offline/v${OFFLINE_VERSION}`)
	})

	it("AUDIO_CACHE_PARENT_DIRECTORY.uri contains 'audioCache/v2' (AUDIO_CACHE_VERSION=2)", async () => {
		const { AUDIO_CACHE_PARENT_DIRECTORY, AUDIO_CACHE_VERSION } = await importRoots("android")

		expect(AUDIO_CACHE_VERSION).toBe(2)
		expect(AUDIO_CACHE_PARENT_DIRECTORY.uri).toContain(`audioCache/v${AUDIO_CACHE_VERSION}`)
	})

	it("THUMBNAILS_DIRECTORY.uri contains 'thumbnails/v4' (THUMBNAILS_VERSION=4)", async () => {
		const { THUMBNAILS_DIRECTORY, THUMBNAILS_VERSION } = await importRoots("android")

		expect(THUMBNAILS_VERSION).toBe(4)
		expect(THUMBNAILS_DIRECTORY.uri).toContain(`thumbnails/v${THUMBNAILS_VERSION}`)
	})

	it("SQLITE_DB_FILE_DIRECTORY.uri contains 'sqlite/v1'", async () => {
		const { SQLITE_DB_FILE_DIRECTORY, SQLITE_VERSION } = await importRoots("android")

		expect(SQLITE_VERSION).toBe(1)
		expect(SQLITE_DB_FILE_DIRECTORY.uri).toContain(`sqlite/v${SQLITE_VERSION}`)
	})

	it("RAW_PREVIEW_CACHE_DIRECTORY.uri contains 'rawPreviews/v1' (RAW_PREVIEW_CACHE_VERSION=1)", async () => {
		const { RAW_PREVIEW_CACHE_DIRECTORY, RAW_PREVIEW_CACHE_VERSION } = await importRoots("android")

		expect(RAW_PREVIEW_CACHE_VERSION).toBe(1)
		expect(RAW_PREVIEW_CACHE_DIRECTORY.uri).toContain(`rawPreviews/v${RAW_PREVIEW_CACHE_VERSION}`)
	})
})

describe("directory hierarchy", () => {
	it("OFFLINE_FILES_DIRECTORY.uri starts with OFFLINE_DIRECTORY.uri (child relationship)", async () => {
		const { OFFLINE_DIRECTORY, OFFLINE_FILES_DIRECTORY } = await importRoots("android")

		expect(OFFLINE_FILES_DIRECTORY.uri).toMatch(new RegExp(`^${escapeRegex(OFFLINE_DIRECTORY.uri)}`))
	})

	it("OFFLINE_DIRECTORIES_DIRECTORY.uri starts with OFFLINE_DIRECTORY.uri (sibling of files)", async () => {
		const { OFFLINE_DIRECTORY, OFFLINE_DIRECTORIES_DIRECTORY } = await importRoots("android")

		expect(OFFLINE_DIRECTORIES_DIRECTORY.uri).toMatch(new RegExp(`^${escapeRegex(OFFLINE_DIRECTORY.uri)}`))
	})

	it("OFFLINE_FILES_DIRECTORY and OFFLINE_DIRECTORIES_DIRECTORY are distinct siblings", async () => {
		const { OFFLINE_FILES_DIRECTORY, OFFLINE_DIRECTORIES_DIRECTORY } = await importRoots("android")

		expect(OFFLINE_FILES_DIRECTORY.uri).not.toBe(OFFLINE_DIRECTORIES_DIRECTORY.uri)
	})

	it("THUMBNAILS_DIRECTORY is the current-version child of THUMBNAILS_PARENT_DIRECTORY", async () => {
		const { THUMBNAILS_PARENT_DIRECTORY, THUMBNAILS_DIRECTORY, THUMBNAILS_VERSION } = await importRoots("android")

		expect(THUMBNAILS_PARENT_DIRECTORY.uri).toMatch(/\/thumbnails$/)
		expect(THUMBNAILS_DIRECTORY.uri).toBe(`${THUMBNAILS_PARENT_DIRECTORY.uri}/v${THUMBNAILS_VERSION}`)
	})
})

describe("iOS appleSharedContainers fallback", () => {
	it("on iOS with a valid app group, path is rooted at the shared container (not document)", async () => {
		const { OFFLINE_DIRECTORY } = await importRoots("ios")
		const { Paths } = await import("expo-file-system")

		// Should NOT be the plain document directory
		expect(OFFLINE_DIRECTORY.uri).not.toContain(Paths.document.uri)
	})
})

// The SQLite databases must NOT live in the shared app-group container: iOS kills a process
// that is suspended while holding a file/SQLite lock there (RUNNINGBOARD 0xdead10cc), and a
// WAL connection holds a shared lock even while idle. Plain-file areas stay shared.
describe("database roots live on the private base (0xdead10cc)", () => {
	it("on iOS, sqlite + sdkCache are rooted at the private base, not the shared container", async () => {
		const { SQLITE_DB_FILE_DIRECTORY, SDK_CACHE_PARENT_DIRECTORY } = await importRoots("ios")
		const { IOS_APP_GROUP_IDENTIFIER } = await import("@/constants")

		expect(SQLITE_DB_FILE_DIRECTORY.uri).not.toContain(IOS_APP_GROUP_IDENTIFIER)
		expect(SDK_CACHE_PARENT_DIRECTORY.uri).not.toContain(IOS_APP_GROUP_IDENTIFIER)
	})

	it("plain-file areas stay on the shared container on iOS", async () => {
		const { OFFLINE_DIRECTORY, FILE_CACHE_PARENT_DIRECTORY, THUMBNAILS_DIRECTORY, LOGS_DIRECTORY } = await importRoots("ios")
		const { IOS_APP_GROUP_IDENTIFIER } = await import("@/constants")

		for (const dir of [OFFLINE_DIRECTORY, FILE_CACHE_PARENT_DIRECTORY, THUMBNAILS_DIRECTORY, LOGS_DIRECTORY]) {
			expect(dir.uri).toContain(IOS_APP_GROUP_IDENTIFIER)
		}
	})
})

describe("private-base derivation helper", () => {
	it("deriveIosLibraryDirectoryUri maps a real iOS Documents URI to the sibling Library dir", async () => {
		const { deriveIosLibraryDirectoryUri } = await importRoots("ios")

		expect(deriveIosLibraryDirectoryUri("file:///var/mobile/Containers/Data/Application/ABC-123/Documents/")).toBe(
			"file:///var/mobile/Containers/Data/Application/ABC-123/Library"
		)
		expect(deriveIosLibraryDirectoryUri("file:///var/mobile/Containers/Data/Application/ABC-123/Documents")).toBe(
			"file:///var/mobile/Containers/Data/Application/ABC-123/Library"
		)
	})

	it("deriveIosLibraryDirectoryUri falls back to the input when no Documents segment exists", async () => {
		const { deriveIosLibraryDirectoryUri } = await importRoots("ios")

		// The vitest mock's document root has no /Documents suffix — the fallback keeps the
		// derivation harmless there (still a private container, just not the Library flavor).
		expect(deriveIosLibraryDirectoryUri("file:///document")).toBe("file:///document")
		expect(deriveIosLibraryDirectoryUri("file:///data/user/0/io.filen.app/files/")).toBe("file:///data/user/0/io.filen.app/files/")
	})
})

// A THUMBNAILS_VERSION bump repoints THUMBNAILS_DIRECTORY at a fresh `v{N}` and the superseded tree
// becomes unreachable: thumbnails.clear(), thumbnails.size() and sweepStrayDownloadFiles() all root at
// the CURRENT version, so without this sweep the old bytes are un-clearable AND missing from the
// user-facing cache-size figure.
describe("stale thumbnail version sweep", () => {
	// A failed assertion aborts the test before its inline mockRestore(), so a throwing
	// Directory spy would leak into the tests that follow and mask what they prove.
	afterEach(() => {
		vi.restoreAllMocks()
	})

	async function importSweep() {
		const { THUMBNAILS_PARENT_DIRECTORY, THUMBNAILS_VERSION } = await importRoots("android")
		const { sweepStaleThumbnailVersions } = await import("@/lib/thumbnailsVersionSweep")
		// Reached through the MOCKED specifier, not the mock module path: vi.resetModules() does not
		// reset the mock registry, so a direct import of the mock file hands back a different in-memory
		// fs than the one the modules under test are wired to from the second test onwards.
		const mock = (await import("expo-file-system")) as unknown as typeof import("@/tests/mocks/expoFileSystem")
		const logger = ((await import("@/lib/logger")) as unknown as typeof import("@/tests/mocks/logger")).default

		mock.fs.clear()
		logger.warn.mockClear()

		const parent = THUMBNAILS_PARENT_DIRECTORY.uri

		return {
			parent,
			current: `v${THUMBNAILS_VERSION}`,
			sweep: sweepStaleThumbnailVersions,
			mock,
			logger,
			seed(version: string): void {
				mock.fs.set(parent, "dir")
				mock.fs.set(`${parent}/${version}`, "dir")
				mock.fs.set(`${parent}/${version}/thumb.webp`, new Uint8Array([1]))
			}
		}
	}

	it("deletes a superseded version tree", async () => {
		const { parent, current, sweep, mock, seed } = await importSweep()

		seed("v3")
		seed(current)

		sweep()

		expect(mock.fs.has(`${parent}/v3`)).toBe(false)
		expect(mock.fs.has(`${parent}/v3/thumb.webp`)).toBe(false)
	})

	it("never deletes the current version tree", async () => {
		const { parent, current, sweep, mock, seed } = await importSweep()

		seed("v3")
		seed(current)

		sweep()

		expect(mock.fs.has(`${parent}/${current}`)).toBe(true)
		expect(mock.fs.has(`${parent}/${current}/thumb.webp`)).toBe(true)
	})

	it("reclaims EVERY non-current version, not only the immediately previous one", async () => {
		const { parent, current, sweep, mock, seed } = await importSweep()

		// An install that skipped releases carries more than one orphan.
		seed("v1")
		seed("v2")
		seed("v3")
		seed(current)

		sweep()

		for (const stale of ["v1", "v2", "v3"]) {
			expect(mock.fs.has(`${parent}/${stale}`)).toBe(false)
		}

		expect(mock.fs.has(`${parent}/${current}/thumb.webp`)).toBe(true)
	})

	it("contains a removal failure — the other stale trees still go and nothing throws out", async () => {
		const { parent, current, sweep, mock, logger, seed } = await importSweep()

		seed("v2")
		seed("v3")
		seed(current)

		const realDelete = mock.Directory.prototype.delete
		const deleteSpy = vi.spyOn(mock.Directory.prototype, "delete").mockImplementation(function (
			this: InstanceType<typeof mock.Directory>
		): void {
			if (this.uri === `${parent}/v2`) {
				throw new Error("EBUSY")
			}

			realDelete.call(this)
		})

		expect(() => sweep()).not.toThrow()

		deleteSpy.mockRestore()

		expect(mock.fs.has(`${parent}/v2`)).toBe(true)
		expect(mock.fs.has(`${parent}/v3`)).toBe(false)
		expect(mock.fs.has(`${parent}/${current}/thumb.webp`)).toBe(true)
		expect(logger.warn).toHaveBeenCalledTimes(1)
	})

	it("contains a listing failure — the sweep never throws into its caller", async () => {
		const { sweep, mock, logger, seed } = await importSweep()

		seed("v3")

		const listSpy = vi.spyOn(mock.Directory.prototype, "list").mockImplementation(() => {
			throw new Error("EIO")
		})

		expect(() => sweep()).not.toThrow()

		listSpy.mockRestore()

		expect(logger.warn).toHaveBeenCalledTimes(1)
	})

	it("skips the pass entirely when the thumbnails parent does not exist", async () => {
		const { sweep, mock } = await importSweep()

		// The native list() throws on a missing directory — the exists guard is what keeps a
		// first-ever launch (nothing on disk yet) off that path.
		const listSpy = vi.spyOn(mock.Directory.prototype, "list")

		sweep()

		expect(listSpy).not.toHaveBeenCalled()

		listSpy.mockRestore()
	})

	it("runs once per process — a tree appearing afterwards waits for the next launch", async () => {
		const { parent, current, sweep, mock, seed } = await importSweep()

		seed("v3")
		seed(current)

		sweep()

		expect(mock.fs.has(`${parent}/v3`)).toBe(false)

		seed("v3")

		sweep()

		expect(mock.fs.has(`${parent}/v3`)).toBe(true)
	})
})

function escapeRegex(str: string): string {
	return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}
