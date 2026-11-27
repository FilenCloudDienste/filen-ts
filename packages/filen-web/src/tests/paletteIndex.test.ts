// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { DriveItem } from "@/features/drive/lib/item"

// The palette's index is built from what the app holds: the mounted handlers, the cached listings, notes and chats.
// Every SDK call is recorded, so a request made while building it fails the test.

interface CachedQuery {
	queryKey: readonly unknown[]
	state: { data: DriveItem[] }
}

const { cached, sdkCalls } = vi.hoisted(() => ({ cached: [] as CachedQuery[], sdkCalls: [] as string[] }))

vi.mock("@/queries/patch", async importOriginal => ({
	...(await importOriginal<typeof import("@/queries/patch")>()),
	cachedQueriesWithPrefix: () => cached
}))
vi.mock("@/lib/sdk/client", () => ({
	sdkApi: new Proxy(
		{},
		{
			get: (_target, name) => () => {
				sdkCalls.push(String(name))

				return Promise.reject(new Error("no request expected"))
			}
		}
	)
}))
vi.mock("@/lib/storage/adapter", () => ({
	kvGetJson: () => Promise.resolve(null),
	kvSetJson: () => Promise.resolve(),
	kvDelete: () => Promise.resolve()
}))
vi.mock("@/lib/desktop", () => ({ isDesktopApp: () => false, desktopBridge: () => undefined }))

await import("@/lib/i18n")

const { registerAllActions } = await import("@/lib/keymap/actions")
const { registerLiveAction } = await import("@/lib/keymap/liveActions")
const { queryClient } = await import("@/queries/client")
const { NOTES_QUERY_KEY } = await import("@/features/notes/queries/notes")
const { CHATS_QUERY_KEY } = await import("@/features/chats/queries/chats")
const { buildPaletteIndex, driveItems } = await import("@/features/palette/lib/paletteIndex")

registerAllActions()

function directory(uuid: string, name: string, parent: string): DriveItem {
	return { type: "directory", data: { uuid, parent, undecryptable: false, decryptedMeta: { name } } } as unknown as DriveItem
}

function file(uuid: string, name: string, parent: string, undecryptable = false): DriveItem {
	return { type: "file", data: { uuid, parent, undecryptable, decryptedMeta: { name } } } as unknown as DriveItem
}

function listing(variant: string, uuid: string | null, rows: DriveItem[]): CachedQuery {
	return { queryKey: ["drive", "listing", { variant, uuid }], state: { data: rows } }
}

function live(id: string, available: (focus: Element | null) => boolean = () => true): () => void {
	return registerLiveAction({ id, available, run: vi.fn() })
}

beforeEach(() => {
	cached.length = 0
	sdkCalls.length = 0
	queryClient.clear()
})

describe("driveItems", () => {
	it("reads My Drive's cached listings, with the chain to open each row at", () => {
		cached.push(
			listing("drive", null, [directory("docs", "Documents", "root"), file("readme", "Readme.md", "root")]),
			listing("drive", "docs", [directory("tax", "Tax", "docs"), file("broken", "x", "docs", true)]),
			listing("drive", "tax", [file("invoice", "Invoice.pdf", "tax")]),
			// A flat listing's rows sit anywhere: never indexed.
			listing("recents", null, [file("elsewhere", "Elsewhere.txt", "unknown")]),
			// Reached by a deep link: no cached listing records its way up.
			listing("drive", "orphan", [file("lost", "Lost.txt", "orphan")])
		)

		const items = driveItems()
		const byKey = new Map(items.map(item => [item.key, item]))

		expect([...byKey.keys()].sort()).toEqual(["drive:docs", "drive:invoice", "drive:readme", "drive:tax"])
		expect(byKey.get("drive:docs")?.target).toEqual({ kind: "directory", splat: "docs" })
		expect(byKey.get("drive:tax")?.target).toEqual({ kind: "directory", splat: "docs/tax" })
		expect(byKey.get("drive:invoice")?.target).toEqual({ kind: "file", uuid: "invoice", splat: "docs/tax" })
		expect(byKey.get("drive:invoice")?.detail).toBe("In Tax")
		expect(byKey.get("drive:readme")?.detail).toBe("In Cloud Drive")
		expect(sdkCalls).toEqual([])
	})

	it("leaves the root .filen out while its setting hides it", () => {
		cached.push(listing("drive", null, [directory("dot", ".filen", "root"), directory("docs", "Documents", "root")]))

		expect(driveItems().map(item => item.title)).toEqual(["Documents"])
	})
})

describe("buildPaletteIndex", () => {
	it("lists the notes and chats the app holds, never a trashed note, and makes no request", () => {
		queryClient.setQueryData(NOTES_QUERY_KEY, [
			{ uuid: "n1", title: "Groceries", encryptionKey: "k", trash: false, archive: false, participants: [] },
			{ uuid: "n2", title: "Old", encryptionKey: "k", trash: true, archive: false, participants: [] }
		])
		queryClient.setQueryData(CHATS_QUERY_KEY, [])

		const keys = buildPaletteIndex({ focus: null, assistantHidden: false }).map(item => item.key)

		expect(keys).toContain("note:n1")
		expect(keys).not.toContain("note:n2")
		expect(sdkCalls).toEqual([])
	})

	it("offers only the actions with a handler mounted, places with the places, never itself", () => {
		const off = [live("app.toggleTheme"), live("app.openDrive"), live("app.commandPalette")]
		const items = buildPaletteIndex({ focus: null, assistantHidden: false }).filter(item => item.target.kind === "action")

		expect(items.map(item => [item.key, item.group])).toEqual([
			["action:app.toggleTheme", "actions"],
			["action:app.openDrive", "navigation"]
		])

		for (const unregister of off) {
			unregister()
		}
	})

	it("offers an action scoped to an element only with focus inside it", () => {
		const row = document.createElement("div")
		const inside = document.createElement("button")

		row.append(inside)

		const off = live("drive.open", focus => focus !== null && row.contains(focus))
		const ids = (focus: Element | null) =>
			buildPaletteIndex({ focus, assistantHidden: false })
				.filter(item => item.target.kind === "action")
				.map(item => item.key)

		expect(ids(inside)).toEqual(["action:drive.open"])
		expect(ids(document.body)).toEqual([])

		off()
	})

	it("leaves the assistant's actions out while the assistant is hidden", () => {
		const off = live("app.toggleAssistant")
		const keys = (assistantHidden: boolean) => buildPaletteIndex({ focus: null, assistantHidden }).map(item => item.key)

		expect(keys(false)).toContain("action:app.toggleAssistant")
		expect(keys(true)).not.toContain("action:app.toggleAssistant")

		off()
	})
})
