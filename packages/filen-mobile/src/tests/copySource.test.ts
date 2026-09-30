import { vi, describe, it, expect } from "vitest"

vi.mock("@filen/sdk-rs", async () => await import("@/tests/mocks/sdkCopy"))
vi.mock("@/lib/sdkUnwrap", () => ({ unwrapParentUuid: (parent: unknown) => (typeof parent === "string" ? parent : null) }))
vi.mock("@/lib/cache", () => ({ default: { directoryUuidToAnySharedDirWithContext: new Map([["shared-parent", { shareInfo: "role" }]]) } }))
vi.mock("@/lib/logger", async () => await import("@/tests/mocks/logger"))
vi.mock("@/constants", () => ({ EXPO_IMAGE_SUPPORTED_EXTENSIONS: new Set(), EXPO_VIDEO_SUPPORTED_EXTENSIONS: new Set() }))

import { copyGlyph, driveItemToCopyItem } from "@/features/copy/copySource"
import { AnyItemWithContext_Tags } from "@/tests/mocks/sdkCopy"
import type { AnyItemWithContext } from "@filen/sdk-rs"
import type { DriveItem } from "@/types"

function item(type: DriveItem["type"], data: Record<string, unknown> = {}): DriveItem {
	return { type, data: { uuid: `${type}-uuid`, ...data } } as unknown as DriveItem
}

type Tagged = { tag: string; inner: [Tagged | Record<string, unknown>] }

describe("driveItemToCopyItem", () => {
	it.each([
		["file", "File"],
		["sharedFile", "Shared"],
		["sharedRootFile", "Shared"]
	] as const)("a %s copies as File(AnyFile.%s)", (type, anyFileTag) => {
		const copyItem = driveItemToCopyItem(item(type)) as unknown as Tagged

		expect(copyItem.tag).toBe(AnyItemWithContext_Tags.File)
		expect((copyItem.inner[0] as Tagged).tag).toBe(anyFileTag)
	})

	it("a directory copies as Dir(AnyDirWithContext.Normal)", () => {
		const copyItem = driveItemToCopyItem(item("directory")) as unknown as Tagged

		expect(copyItem.tag).toBe(AnyItemWithContext_Tags.Dir)
		expect((copyItem.inner[0] as Tagged).tag).toBe("Normal")
	})

	it("a shared directory carries its parent's share context", () => {
		const copyItem = driveItemToCopyItem(item("sharedDirectory", { inner: { parent: "shared-parent" } })) as unknown as Tagged
		const withContext = copyItem.inner[0] as Tagged

		expect(withContext.tag).toBe("Shared")
		expect((withContext.inner[0] as { shareInfo: unknown }).shareInfo).toBe("role")
	})

	it("a shared directory without any share context is refused, not copied from the wrong root", () => {
		expect(() => driveItemToCopyItem(item("sharedDirectory", { inner: { parent: "unknown-parent" } }))).toThrow("missing its share context")
	})
})

describe("copyGlyph", () => {
	it("one directory, one file, or several items", () => {
		const dir = { tag: AnyItemWithContext_Tags.Dir } as unknown as AnyItemWithContext
		const file = { tag: AnyItemWithContext_Tags.File } as unknown as AnyItemWithContext

		expect(copyGlyph(0, undefined)).toBe("items")
		expect(copyGlyph(1, dir)).toBe("directory")
		expect(copyGlyph(1, file)).toBe("file")
		expect(copyGlyph(1, driveItemToCopyItem(item("sharedRootDirectory")))).toBe("directory")
		expect(copyGlyph(2, file)).toBe("items")
	})
})
