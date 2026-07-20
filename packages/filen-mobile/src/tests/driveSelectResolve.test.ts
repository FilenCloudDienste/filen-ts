import { vi, describe, it, expect, beforeEach } from "vitest"
vi.mock("@/lib/logger", async () => await import("@/tests/mocks/logger"))

const { cacheDirectoryUuidToAnyNormalDir } = vi.hoisted(() => ({
	cacheDirectoryUuidToAnyNormalDir: new Map<string, unknown>()
}))

vi.mock("@/lib/cache", () => ({
	default: {
		directoryUuidToAnyNormalDir: cacheDirectoryUuidToAnyNormalDir
	}
}))

vi.mock("@filen/sdk-rs", () => ({
	AnyNormalDir: {
		Dir: class {
			tag = "Dir"
			inner: unknown[]
			constructor(v: unknown) {
				this.inner = [v]
			}
		},
		Root: class {
			tag = "Root"
			inner: unknown[]
			constructor(v: unknown) {
				this.inner = [v]
			}
		}
	}
}))

import { resolveSelectedDriveItemToAnyNormalDir } from "@/features/drive/driveSelectResolve"
import logger from "@/lib/logger"

type SelectedItem = Parameters<typeof resolveSelectedDriveItemToAnyNormalDir>[0]

beforeEach(() => {
	cacheDirectoryUuidToAnyNormalDir.clear()
	vi.mocked(logger.warn).mockClear()
})

describe("resolveSelectedDriveItemToAnyNormalDir", () => {
	it("passes a root selection straight through", () => {
		const root = { tag: "Root", inner: [{ uuid: "root-uuid" }] }
		const selected = { type: "root", data: root } as unknown as SelectedItem

		const result = resolveSelectedDriveItemToAnyNormalDir(selected)

		expect(result).toBe(root)
		expect(vi.mocked(logger.warn)).not.toHaveBeenCalled()
	})

	it("returns the cached AnyNormalDir when the picked directory is in the cache", () => {
		const cached = { tag: "Dir", inner: [{ uuid: "dir-cached" }] }

		cacheDirectoryUuidToAnyNormalDir.set("dir-cached", cached)

		const selected = {
			type: "driveItem",
			data: { type: "directory", data: { uuid: "dir-cached" } }
		} as unknown as SelectedItem

		const result = resolveSelectedDriveItemToAnyNormalDir(selected)

		expect(result).toBe(cached)
		expect(vi.mocked(logger.warn)).not.toHaveBeenCalled()
	})

	it("builds an AnyNormalDir.Dir by value on a cache miss for an own directory", () => {
		const dirData = { uuid: "dir-uncached", name: "encrypted" }
		const selected = {
			type: "driveItem",
			data: { type: "directory", data: dirData }
		} as unknown as SelectedItem

		const result = resolveSelectedDriveItemToAnyNormalDir(selected) as { tag: string; inner: unknown[] } | null

		expect(result).not.toBeNull()
		expect(result?.tag).toBe("Dir")
		// The constructed Dir wraps the selected item's own data by value.
		expect(result?.inner[0]).toBe(dirData)
		expect(vi.mocked(logger.warn)).not.toHaveBeenCalled()
	})

	it("returns null and warns on a cache miss for a non-own directory (sharedDirectory)", () => {
		const selected = {
			type: "driveItem",
			data: { type: "sharedDirectory", data: { uuid: "dir-shared" } }
		} as unknown as SelectedItem

		const result = resolveSelectedDriveItemToAnyNormalDir(selected)

		expect(result).toBeNull()
		expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
			"drive",
			expect.stringContaining("Could not resolve"),
			expect.objectContaining({ uuid: "dir-shared", type: "sharedDirectory" })
		)
	})
})
