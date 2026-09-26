import { describe, expect, it } from "vitest"
import {
	DEFAULT_RAIL_ORDER,
	moveRailEntry,
	normalizeRailOrder,
	railDropIndex,
	railEntryActive,
	railShift
} from "@/features/shell/lib/railOrder.logic"

describe("normalizeRailOrder", () => {
	it("defaults when nothing is stored", () => {
		expect(normalizeRailOrder(null)).toEqual(["drive", "photos", "transfers", "notes", "chats", "playlists", "contacts", "settings"])
	})

	it("keeps a stored order", () => {
		const stored = ["settings", "chats", "drive", "photos", "transfers", "notes", "playlists", "contacts"]

		expect(normalizeRailOrder(stored)).toEqual(stored)
	})

	it("drops unknown and repeated ids and appends entries the stored order lacks", () => {
		expect(normalizeRailOrder(["chats", "gone", "chats", "drive"])).toEqual([
			"chats",
			"drive",
			"photos",
			"transfers",
			"notes",
			"playlists",
			"contacts",
			"settings"
		])
	})
})

describe("moveRailEntry", () => {
	it("moves an entry down, the others keeping their order", () => {
		expect(moveRailEntry(["drive", "photos", "transfers", "notes"], 0, 2)).toEqual(["photos", "transfers", "drive", "notes"])
	})

	it("moves an entry up", () => {
		expect(moveRailEntry(["drive", "photos", "transfers", "notes"], 3, 1)).toEqual(["drive", "notes", "photos", "transfers"])
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
		expect(railEntryActive("photos", "/photos")).toBe(true)
		expect(railEntryActive("contacts", "/contacts")).toBe(true)
		expect(railEntryActive("transfers", "/transfers/x")).toBe(false)
		expect(railEntryActive("drive", "/drivers")).toBe(false)
	})
})
