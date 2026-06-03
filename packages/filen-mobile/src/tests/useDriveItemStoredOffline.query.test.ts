import { vi, describe, it, expect, beforeEach } from "vitest"

const { mockQueryUpdaterSet } = vi.hoisted(() => ({
	mockQueryUpdaterSet: vi.fn()
}))

vi.mock("uniffi-bindgen-react-native", async () => await import("@/tests/mocks/uniffiBindgenReactNative"))

vi.mock("react-native", async () => await import("@/tests/mocks/reactNative"))

vi.mock("@filen/utils", async () => {
	const real = await import("@/tests/mocks/filenUtils")
	const { sortParams } = await import("@filen/utils")

	return {
		...real,
		sortParams
	}
})

vi.mock("@/queries/client", () => ({
	DEFAULT_QUERY_OPTIONS: {},
	queryUpdater: {
		set: mockQueryUpdaterSet,
		get: vi.fn()
	}
}))

vi.mock("@/lib/cache", () => ({
	default: {
		uuidToAnyDriveItem: new Map()
	}
}))

vi.mock("@/lib/offline", () => ({
	default: {
		isItemStored: vi.fn().mockResolvedValue(false)
	}
}))

vi.mock("@filen/sdk-rs", () => ({}))

import { driveItemStoredOfflineQueryUpdate, BASE_QUERY_KEY } from "@/queries/useDriveItemStoredOffline.query"

// normalizeTypeForKey is private but its effect is observable via the query key emitted
// by driveItemStoredOfflineQueryUpdate. Two variants that should normalize to the same
// base type must produce identical query keys.
function captureKeyFor(type: "file" | "sharedFile" | "sharedRootFile" | "directory" | "sharedDirectory" | "sharedRootDirectory"): unknown[] {
	driveItemStoredOfflineQueryUpdate({
		params: { uuid: "test-uuid", type },
		updater: false
	})

	const call = mockQueryUpdaterSet.mock.calls.at(-1)!

	return call[0] as unknown[]
}

beforeEach(() => {
	mockQueryUpdaterSet.mockClear()
})

describe("normalizeTypeForKey (via driveItemStoredOfflineQueryUpdate key)", () => {
	it("normalizes 'file' to 'file'", () => {
		const key = captureKeyFor("file")

		expect(key[0]).toBe(BASE_QUERY_KEY)
		expect((key[1] as Record<string, unknown>)["type"]).toBe("file")
	})

	it("normalizes 'sharedFile' to 'file'", () => {
		const key = captureKeyFor("sharedFile")

		expect((key[1] as Record<string, unknown>)["type"]).toBe("file")
	})

	it("normalizes 'sharedRootFile' to 'file'", () => {
		const key = captureKeyFor("sharedRootFile")

		expect((key[1] as Record<string, unknown>)["type"]).toBe("file")
	})

	it("normalizes 'directory' to 'directory'", () => {
		const key = captureKeyFor("directory")

		expect((key[1] as Record<string, unknown>)["type"]).toBe("directory")
	})

	it("normalizes 'sharedDirectory' to 'directory'", () => {
		const key = captureKeyFor("sharedDirectory")

		expect((key[1] as Record<string, unknown>)["type"]).toBe("directory")
	})

	it("normalizes 'sharedRootDirectory' to 'directory'", () => {
		const key = captureKeyFor("sharedRootDirectory")

		expect((key[1] as Record<string, unknown>)["type"]).toBe("directory")
	})

	it("'file' and 'sharedFile' produce the same query key (shared cache entry)", () => {
		const keyFile = captureKeyFor("file")
		const keySharedFile = captureKeyFor("sharedFile")

		expect(keyFile).toEqual(keySharedFile)
	})

	it("'file' and 'sharedRootFile' produce the same query key", () => {
		const keyFile = captureKeyFor("file")
		const keySharedRootFile = captureKeyFor("sharedRootFile")

		expect(keyFile).toEqual(keySharedRootFile)
	})

	it("'directory' and 'sharedDirectory' produce the same query key", () => {
		const keyDir = captureKeyFor("directory")
		const keySharedDir = captureKeyFor("sharedDirectory")

		expect(keyDir).toEqual(keySharedDir)
	})

	it("'directory' and 'sharedRootDirectory' produce the same query key", () => {
		const keyDir = captureKeyFor("directory")
		const keySharedRootDir = captureKeyFor("sharedRootDirectory")

		expect(keyDir).toEqual(keySharedRootDir)
	})

	it("file-type and directory-type keys are different (no cross-contamination)", () => {
		const keyFile = captureKeyFor("file")
		const keyDir = captureKeyFor("directory")

		expect(keyFile).not.toEqual(keyDir)
	})
})
