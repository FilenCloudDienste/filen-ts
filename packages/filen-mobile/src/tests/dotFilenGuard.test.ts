import { vi, describe, it, expect, beforeEach } from "vitest"
import { filterHiddenItems } from "@filen/shared"

const { inputPrompt, normal, cache, known } = vi.hoisted(() => ({
	inputPrompt: vi.fn(),
	normal: vi.fn(),
	cache: { rootUuid: "root" as string | null },
	known: { dotFilen: null as string | null, dirs: new Set<string>() }
}))

vi.mock("@/lib/cache", () => ({ default: cache }))
vi.mock("@/lib/promptFlow", () => ({ inputPrompt }))
vi.mock("@/lib/alerts", () => ({ default: { normal } }))
vi.mock("@/lib/i18n", async () => await import("@/tests/mocks/i18n"))
vi.mock("@/lib/dotFilenKnown", () => ({
	getKnownDotFilenUuid: () => known.dotFilen,
	isKnownDotFilenDir: (uuid: string) => known.dirs.has(uuid)
}))
// Fixtures carry their parent as a plain uuid string, or as `{ trashedFrom }` for a trashed item.
vi.mock("@/lib/sdkUnwrap", () => ({
	normalParentUuidOf: (item: { type: string; data: { parent: unknown } }) =>
		(item.type === "file" || item.type === "directory") && typeof item.data.parent === "string" ? item.data.parent : null,
	trashedFromParentUuid: (parent: unknown) =>
		typeof parent === "object" && parent !== null && "trashedFrom" in parent ? String(parent.trashedFrom) : null
}))

import { confirmDotFilenOperation, emptyTrashMessage, includesRootDotFilen, isRootDotFilenItem, rootDotFilenFilter } from "@/features/drive/dotFilenGuard"
import { type DriveItem } from "@/types"
import { type DrivePath, type DrivePathType } from "@/hooks/useDrivePath"

function item(uuid: string, name: string, parent: string | { trashedFrom: string } = "root", type: "directory" | "file" = "directory"): DriveItem {
	return { type, data: { uuid, parent, decryptedMeta: { name } } } as unknown as DriveItem
}

const dotFilen = item("a", ".filen")
const docs = item("b", "Docs")

function path(type: DrivePathType, uuid: string | null): DrivePath {
	return { type, uuid }
}

beforeEach(() => {
	vi.clearAllMocks()
	cache.rootUuid = "root"
	known.dotFilen = null
	known.dirs.clear()
})

describe("isRootDotFilenItem", () => {
	it("matches only the .filen directory directly under the drive root", () => {
		expect(isRootDotFilenItem(dotFilen)).toBe(true)
		expect(isRootDotFilenItem(item("c", ".Filen"))).toBe(true)
		expect(isRootDotFilenItem(item("d", ".filen", "docs"))).toBe(false)
		expect(isRootDotFilenItem(item("e", ".filen", "root", "file"))).toBe(false)
		expect(includesRootDotFilen([docs])).toBe(false)
	})

	it("matches a trashed .filen by the root its trash marker remembers", () => {
		expect(isRootDotFilenItem(item("t", ".filen", { trashedFrom: "root" }))).toBe(true)
		expect(isRootDotFilenItem(item("u", ".filen", { trashedFrom: "docs" }))).toBe(false)
	})

	it("matches the uuid the resolver holds", () => {
		known.dotFilen = "moved"

		expect(isRootDotFilenItem(item("moved", "settings", "docs"))).toBe(true)
	})

	it("matches nothing before the root is known", () => {
		cache.rootUuid = null

		expect(isRootDotFilenItem(dotFilen)).toBe(false)
	})
})

describe("confirmDotFilenOperation", () => {
	it("goes on without a prompt when no root .filen is involved", async () => {
		await expect(confirmDotFilenOperation("trash", [docs])).resolves.toBe(true)
		expect(inputPrompt).not.toHaveBeenCalled()
	})

	it("goes on once .filen is typed, worded for the operation", async () => {
		inputPrompt.mockResolvedValueOnce(".filen")

		await expect(confirmDotFilenOperation("move", [dotFilen, docs])).resolves.toBe(true)
		expect(inputPrompt.mock.calls[0]?.[0]).toMatchObject({
			title: "dot_filen_move_title",
			message: "dot_filen_message_selection",
			okText: "dot_filen_move_confirm",
			destructive: true
		})
	})

	it("changes nothing on anything else typed, and says so", async () => {
		inputPrompt.mockResolvedValueOnce(".Filen")

		await expect(confirmDotFilenOperation("rename", [dotFilen])).resolves.toBe(false)
		expect(normal).toHaveBeenCalledOnce()
	})

	it("changes nothing on a cancel, silently", async () => {
		inputPrompt.mockResolvedValueOnce(null)

		await expect(confirmDotFilenOperation("delete", [dotFilen])).resolves.toBe(false)
		expect(normal).not.toHaveBeenCalled()
	})
})

describe("rootDotFilenFilter", () => {
	it("hides the root .filen in the browser and the pickers, not the hidden-items count's business", () => {
		const items = [dotFilen, docs, item("f", ".env")]
		const filter = rootDotFilenFilter({ show: false, drivePath: path("drive", "root") })

		expect(filterHiddenItems({ items, hide: false, rootDotFilen: filter })).toEqual([docs, items[2]])
	})

	it("hides nothing while shown, where it can't appear, or before the root is known", () => {
		expect(rootDotFilenFilter({ show: true, drivePath: path("drive", "root") })).toBeUndefined()
		expect(rootDotFilenFilter({ show: false, drivePath: path("trash", null) })).toBeUndefined()
		expect(rootDotFilenFilter({ show: false, drivePath: path("drive", "docs") })).toBeUndefined()
		expect(rootDotFilenFilter({ show: false, drivePath: path("favorites", "docs") })).toBeUndefined()

		cache.rootUuid = null

		expect(rootDotFilenFilter({ show: false, drivePath: path("drive", "root") })).toBeUndefined()
	})

	it("drops what sits inside .filen from recents and favorites, as far as the resolver knows it", () => {
		const settings = item("s", "library.v1.json", "videos-dir", "file")
		const unknown = item("p", "list.json", "playlists-dir", "file")
		const items = [settings, unknown, docs]

		known.dirs.add("videos-dir")

		for (const type of ["recents", "favorites"] as const) {
			expect(filterHiddenItems({ items, hide: false, rootDotFilen: rootDotFilenFilter({ show: false, drivePath: path(type, null) }) })).toEqual([
				unknown,
				docs
			])
		}

		expect(filterHiddenItems({ items, hide: false, rootDotFilen: rootDotFilenFilter({ show: true, drivePath: path("recents", null) }) })).toBe(
			items
		)
	})

	it("returns the listing itself when nothing is removed", () => {
		const items = [docs]

		expect(filterHiddenItems({ items, hide: false, rootDotFilen: rootDotFilenFilter({ show: false, drivePath: path("drive", "root") }) })).toBe(
			items
		)
	})
})

describe("emptyTrashMessage", () => {
	it("adds a paragraph when the trash holds the root .filen, and only then", () => {
		expect(emptyTrashMessage([docs])).toBe("are_you_sure_empty_trash")
		expect(emptyTrashMessage([item("t", ".filen", { trashedFrom: "root" }), docs])).toBe(
			"are_you_sure_empty_trash\n\nempty_trash_dot_filen_note"
		)
	})
})
