import { describe, expect, it } from "vitest"
import {
	DEFAULT_RAIL_ORDER,
	mergeRailOrder,
	moveRailEntry,
	normalizeRailOrder,
	railDropIndex,
	railEntryActive,
	railShift,
	visibleRailOrder
} from "@/features/shell/lib/railOrder.logic"

describe("normalizeRailOrder", () => {
	it("defaults when nothing is stored", () => {
		expect(normalizeRailOrder(null)).toEqual(["drive", "media", "notes", "chats", "contacts", "computer", "settings"])
	})

	it("keeps a stored order", () => {
		const stored = ["settings", "chats", "drive", "computer", "media", "notes", "contacts"]

		expect(normalizeRailOrder(stored)).toEqual(stored)
	})

	it("drops unknown and repeated ids and puts each entry the stored order lacks after its default predecessor", () => {
		expect(normalizeRailOrder(["chats", "gone", "chats", "drive"])).toEqual([
			"chats",
			"contacts",
			"computer",
			"settings",
			"drive",
			"media",
			"notes"
		])
	})

	it("puts a missing first entry first", () => {
		expect(normalizeRailOrder(["media", "notes", "chats", "contacts", "computer", "settings"])).toEqual(normalizeRailOrder(null))
	})
})

describe("normalizeRailOrder on an order stored before groups", () => {
	it("reads the old default as the new one", () => {
		expect(
			normalizeRailOrder([
				"drive",
				"photos",
				"videos",
				"transfers",
				"sync",
				"mounts",
				"notes",
				"chats",
				"playlists",
				"contacts",
				"settings"
			])
		).toEqual(DEFAULT_RAIL_ORDER)
	})

	it("puts Media where the first media module was and Computer in its default slot", () => {
		expect(
			normalizeRailOrder([
				"settings",
				"playlists",
				"chats",
				"mounts",
				"drive",
				"photos",
				"transfers",
				"sync",
				"notes",
				"videos",
				"contacts"
			])
		).toEqual(["settings", "media", "chats", "drive", "notes", "contacts", "computer"])
	})
})

describe("visibleRailOrder", () => {
	it("hides the Computer group in a browser", () => {
		expect(visibleRailOrder(DEFAULT_RAIL_ORDER, { desktop: false })).not.toContain("computer")
		expect(visibleRailOrder(DEFAULT_RAIL_ORDER, { desktop: true })).toEqual(DEFAULT_RAIL_ORDER)
	})
})

describe("mergeRailOrder", () => {
	it("a browser reorder keeps the hidden Computer group's slot", () => {
		const full = normalizeRailOrder(null)
		const visible = visibleRailOrder(full, { desktop: false })
		const merged = mergeRailOrder(full, moveRailEntry(visible, 0, visible.length - 1))

		expect(merged).toEqual(["media", "notes", "chats", "contacts", "settings", "computer", "drive"])
		expect(visibleRailOrder(merged, { desktop: false })).toEqual(moveRailEntry(visible, 0, visible.length - 1))
	})

	it("is the reordered list itself when nothing is hidden", () => {
		const next = moveRailEntry(DEFAULT_RAIL_ORDER, 4, 0)

		expect(mergeRailOrder(DEFAULT_RAIL_ORDER, next)).toEqual(next)
	})
})

describe("moveRailEntry", () => {
	it("moves an entry down, the others keeping their order", () => {
		expect(moveRailEntry(["drive", "media", "chats", "notes"], 0, 2)).toEqual(["media", "chats", "drive", "notes"])
	})

	it("moves an entry up", () => {
		expect(moveRailEntry(["drive", "media", "chats", "notes"], 3, 1)).toEqual(["drive", "notes", "media", "chats"])
	})

	it("leaves the order alone for a move onto itself or an unknown slot", () => {
		expect(moveRailEntry(DEFAULT_RAIL_ORDER, 2, 2)).toEqual(DEFAULT_RAIL_ORDER)
		expect(moveRailEntry(DEFAULT_RAIL_ORDER, 99, 0)).toEqual(DEFAULT_RAIL_ORDER)
	})
})

describe("railDropIndex", () => {
	it("moves by whole slots, rounding to the nearest", () => {
		expect(railDropIndex(2, 20, 42, 8)).toBe(2)
		expect(railDropIndex(2, 22, 42, 8)).toBe(3)
		expect(railDropIndex(2, -90, 42, 8)).toBe(0)
	})

	it("stays within the list", () => {
		expect(railDropIndex(1, -500, 42, 8)).toBe(0)
		expect(railDropIndex(6, 500, 42, 8)).toBe(7)
	})
})

describe("railShift", () => {
	it("opens the gap by moving the entries between the two slots one slot toward the start", () => {
		expect([0, 1, 2, 3, 4].map(index => railShift(index, 1, 3, 42))).toEqual([0, 0, -42, -42, 0])
		expect([0, 1, 2, 3, 4].map(index => railShift(index, 3, 1, 42))).toEqual([0, 42, 42, 0, 0])
	})

	it("moves nothing while the entry is over its own slot", () => {
		expect([0, 1, 2].map(index => railShift(index, 1, 1, 42))).toEqual([0, 0, 0])
	})
})

describe("railEntryActive", () => {
	it("covers the nested routes of the sections that have them", () => {
		expect(railEntryActive("drive", "/drive/abc/def")).toBe(true)
		expect(railEntryActive("notes", "/notes/uuid")).toBe(true)
		expect(railEntryActive("chats", "/chats")).toBe(true)
		expect(railEntryActive("settings", "/settings/appearance")).toBe(true)
	})

	it("matches the single-page sections exactly", () => {
		expect(railEntryActive("contacts", "/contacts")).toBe(true)
		expect(railEntryActive("drive", "/drivers")).toBe(false)
	})

	it("marks a group active inside any of its children", () => {
		expect(railEntryActive("media", "/photos")).toBe(true)
		expect(railEntryActive("media", "/videos/library/abc")).toBe(true)
		expect(railEntryActive("media", "/playlists")).toBe(true)
		expect(railEntryActive("media", "/transfers")).toBe(false)
		expect(railEntryActive("computer", "/sync/1")).toBe(true)
		expect(railEntryActive("computer", "/mounts/webdav")).toBe(true)
		expect(railEntryActive("computer", "/syncx")).toBe(false)
	})
})
