import { vi, describe, it, expect, beforeEach } from "vitest"

// storageRoots.ts constructs module-level constants at import time, relying on
// Platform.OS and expo-file-system.  We test different platform branches by
// resetting modules and dynamically re-importing after patching the mocks.

vi.mock("expo-file-system", async () => await import("@/tests/mocks/expoFileSystem"))

// @/constants is node-safe — import the real one so IOS_APP_GROUP_IDENTIFIER is real.
vi.mock("@/constants", async () => await import("@/tests/mocks/constants"))

// react-native is globally aliased to the minimal mock — the mock exports a mutable
// Platform object so we can control Platform.OS per test.
vi.mock("react-native", async () => await import("@/tests/mocks/reactNative"))

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

	it("THUMBNAILS_DIRECTORY.uri contains 'thumbnails/v3' (THUMBNAILS_VERSION=3)", async () => {
		const { THUMBNAILS_DIRECTORY, THUMBNAILS_VERSION } = await importRoots("android")

		expect(THUMBNAILS_VERSION).toBe(3)
		expect(THUMBNAILS_DIRECTORY.uri).toContain(`thumbnails/v${THUMBNAILS_VERSION}`)
	})

	it("SQLITE_DB_FILE_DIRECTORY.uri contains 'sqlite/v1'", async () => {
		const { SQLITE_DB_FILE_DIRECTORY, SQLITE_VERSION } = await importRoots("android")

		expect(SQLITE_VERSION).toBe(1)
		expect(SQLITE_DB_FILE_DIRECTORY.uri).toContain(`sqlite/v${SQLITE_VERSION}`)
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

function escapeRegex(str: string): string {
	return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}
