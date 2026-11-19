import { describe, expect, it } from "vitest"
import {
	AUTO_COMPLETE_ENTRIES,
	AUTO_COMPLETE_REACH,
	autoCompleteIndex,
	autoCompletion,
	columnEntries,
	type AutoCompleteCells
} from "../core/sheet/autoComplete/autoComplete"
import { openKeys, sheetBody } from "./sheetKeysFixtures"
import { cells } from "./sheetSessionFixtures"

// A column from cells: text, numbers, or null for empty.
function column(values: (string | number | null)[]): AutoCompleteCells {
	return {
		entry: row => {
			const value = values[row] ?? null

			return value === null ? undefined : typeof value === "string" ? value : null
		}
	}
}

const texts = (found: { readonly entries: readonly { readonly text: string }[] }): string[] => found.entries.map(entry => entry.text)

describe("AutoComplete entries", () => {
	it("reads the run of filled cells round the cell, up first, each text once regardless of case", () => {
		const cells = column(["far", null, "Apple", 3, "apple", "Banana", null, "Cherry", "Date", null, "near"])

		expect(texts(columnEntries(cells, 6, 0, 11))).toEqual(["Banana", "apple", "Cherry", "Date"])
		// The edited cell itself is left out.
		expect(texts(columnEntries(cells, 4, 0, 11))).toEqual(["Apple", "Banana"])
		expect(columnEntries(cells, 4, 0, 11).more).toBe(false)
	})

	it("reads a long run only AUTO_COMPLETE_REACH cells each way, nearest first", () => {
		const rows = 3 * AUTO_COMPLETE_REACH
		const row = Math.floor(rows / 2)
		const visited = new Set<number>()
		// Few distinct texts, so the reach and not the entries bounds the read.
		const cells: AutoCompleteCells = {
			entry: at => {
				visited.add(at)

				return `entry ${at % 100}`
			}
		}
		const found = columnEntries(cells, row, 0, rows)

		// Each way's reach, and the one cell past it that tells the run goes on.
		expect(visited.size).toBe(2 * AUTO_COMPLETE_REACH + 2)
		expect(Math.min(...visited)).toBe(row - AUTO_COMPLETE_REACH - 1)
		expect(Math.max(...visited)).toBe(row + AUTO_COMPLETE_REACH + 1)
		expect(found.entries).toHaveLength(100)
		expect(found.entries[0]).toEqual({ row: row - 1, text: `entry ${(row - 1) % 100}` })
		expect(found.more).toBe(true)
	})

	it("keeps at most AUTO_COMPLETE_ENTRIES distinct entries, nearest first, within a budget", () => {
		const rows = 500_000
		const row = 250_000
		let reads = 0
		const cells: AutoCompleteCells = {
			entry: at => {
				reads++

				return `entry ${at}`
			}
		}
		const started = performance.now()
		const found = columnEntries(cells, row, 0, rows)

		expect(performance.now() - started).toBeLessThan(250)
		expect(found.entries).toHaveLength(AUTO_COMPLETE_ENTRIES)
		expect(found.entries[0]).toEqual({ row: row - 1, text: `entry ${row - 1}` })
		expect(found.entries.at(-1)).toEqual({ row: row - AUTO_COMPLETE_ENTRIES, text: `entry ${row - AUTO_COMPLETE_ENTRIES}` })
		expect(found.more).toBe(true)
		// The kept entries, the cell that found them full, and one cell below to tell the run goes on.
		expect(reads).toBe(AUTO_COMPLETE_ENTRIES + 2)
	})

	it("stops at the sheet's edges without more", () => {
		const cells = column(["a", "b", "c"])

		expect(columnEntries(cells, 0, 0, 3)).toEqual({
			entries: [
				{ row: 1, text: "b" },
				{ row: 2, text: "c" }
			],
			more: false
		})
		expect(columnEntries(cells, 5, 0, 3)).toEqual({ entries: [], more: false })
	})

	it("completes only when exactly one entry starts with what is typed", () => {
		const index = autoCompleteIndex(["Apple", "Apricot", "Banana", "app store"])

		expect(autoCompletion(index, "b")).toBe("Banana")
		expect(autoCompletion(index, "BAN")).toBe("Banana")
		// Two entries start with "ap", and with "app".
		expect(autoCompletion(index, "ap")).toBeNull()
		expect(autoCompletion(index, "app")).toBeNull()
		expect(autoCompletion(index, "apr")).toBe("Apricot")
		// Typed out in full: nothing left to complete.
		expect(autoCompletion(index, "banana")).toBeNull()
		expect(autoCompletion(index, "")).toBeNull()
		expect(autoCompletion(index, "x")).toBeNull()
	})

	it("is a query over an xlsx sheet: typed text only, with what choosing each enters", async () => {
		const rows = [["Fruit"], ["Apple"], [12], ["=A2"], ["Banana"], [null], ["Cherry"]]
		const { session } = await openKeys({ sheets: [{ name: "One", body: sheetBody(rows) }] })

		expect(await session.query("autoComplete.entries", { sheet: 0, row: 5, col: 0 })).toEqual({
			entries: [
				{ text: "Banana", input: "Banana" },
				{ text: "Apple", input: "Apple" },
				{ text: "Fruit", input: "Fruit" },
				{ text: "Cherry", input: "Cherry" }
			],
			more: false
		})
	})

	it("enters text that would read as a number with its leading quote", async () => {
		const { session } = await openKeys({ sheets: [{ name: "One", body: "<sheetData/>" }] })

		await session.command({
			type: "cells.set",
			sheet: 0,
			cells: cells([
				[0, 0, "'12"],
				[1, 0, "Apple"]
			])
		})
		expect(await session.query("autoComplete.entries", { sheet: 0, row: 2, col: 0 })).toEqual({
			entries: [
				{ text: "Apple", input: "Apple" },
				{ text: "12", input: "'12" }
			],
			more: false
		})
	})

	it("is a query over a text file, numbers left out", async () => {
		const { session } = await openKeys("Name\nalpha\n42\nbeta\n\ngamma\n")

		expect(await session.query("autoComplete.entries", { sheet: 0, row: 4, col: 0 })).toEqual({
			entries: [
				{ text: "beta", input: "beta" },
				{ text: "alpha", input: "alpha" },
				{ text: "Name", input: "Name" },
				{ text: "gamma", input: "gamma" }
			],
			more: false
		})
	})
})
