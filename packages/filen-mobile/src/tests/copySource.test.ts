import { vi, describe, it, expect } from "vitest"

vi.mock("uniffi-bindgen-react-native", async () => await import("@/tests/mocks/uniffiBindgenReactNative"))
vi.mock("@filen/sdk-rs", async () => await import("@/tests/mocks/sdkCopy"))
vi.mock("@/lib/sdkUnwrap", () => ({ unwrapParentUuid: (parent: unknown) => (typeof parent === "string" ? parent : null) }))
vi.mock("@/lib/cache", () => ({ default: { directoryUuidToAnySharedDirWithContext: new Map([["shared-parent", { shareInfo: "role" }]]) } }))

import { copyGlyphForCopyItems, copyGlyphForEntries, copyGlyphForItems, driveItemToCopyItem } from "@/features/copy/copySource"
import { CopyItem_Tags } from "@/tests/mocks/sdkCopy"
import type { CopyEntry, CopyItem } from "@filen/sdk-rs"
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

		expect(copyItem.tag).toBe(CopyItem_Tags.File)
		expect((copyItem.inner[0] as Tagged).tag).toBe(anyFileTag)
	})

	it("a directory copies as Dir(AnyDirWithContext.Normal)", () => {
		const copyItem = driveItemToCopyItem(item("directory")) as unknown as Tagged

		expect(copyItem.tag).toBe(CopyItem_Tags.Dir)
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

describe("copy glyphs", () => {
	it("one directory, one file, or several items", () => {
		expect(copyGlyphForItems([item("directory")])).toBe("directory")
		expect(copyGlyphForItems([item("sharedRootDirectory")])).toBe("directory")
		expect(copyGlyphForItems([item("file")])).toBe("file")
		expect(copyGlyphForItems([item("file"), item("file")])).toBe("items")
		expect(copyGlyphForCopyItems([{ tag: CopyItem_Tags.Dir } as unknown as CopyItem])).toBe("directory")
		expect(copyGlyphForEntries([{ item: { tag: CopyItem_Tags.File } } as unknown as CopyEntry])).toBe("file")
		expect(copyGlyphForEntries([])).toBe("items")
	})
})
