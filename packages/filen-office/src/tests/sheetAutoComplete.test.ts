import { describe, expect, it } from "vitest"
import { autoCompleteIndex, autoCompletion, columnEntries, type AutoCompleteCells } from "../core/sheet/autoComplete/autoComplete"
import { openKeys, sheetBody } from "./sheetKeysFixtures"

// A column from cells: text, numbers, or null for empty.
function column(values: (string | number | null)[]): AutoCompleteCells {
	return {
		filled: row => (values[row] ?? null) !== null,
		text: row => {
			const value = values[row] ?? null

			return typeof value === "string" ? value : null
		}
	}
}

const texts = (found: readonly { readonly text: string }[]): string[] => found.map(entry => entry.text)

describe("AutoComplete entries", () => {
	it("reads the run of filled cells round the cell, up first, each text once regardless of case", () => {
		const cells = column(["far", null, "Apple", 3, "apple", "Banana", null, "Cherry", "Date", null, "near"])

		expect(texts(columnEntries(cells, 6, 0, 11))).toEqual(["Banana", "apple", "Cherry", "Date"])
		// The edited cell itself is left out.
		expect(texts(columnEntries(cells, 4, 0, 11))).toEqual(["Apple", "Banana"])
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
			]
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
			]
		})
	})
})
