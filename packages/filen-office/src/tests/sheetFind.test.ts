import { strFromU8, strToU8, unzipSync, zipSync } from "fflate"
import { describe, expect, it } from "vitest"
import { findMatcher, foldText } from "../core/sheet/find/match"
import { CellFlag, type SheetQueryResult, type SheetSessionApi } from "../core/sheet/protocol"
import { buildFixture, firstTile, tileEntry } from "./sheetSessionFixtures"
import { openKeys, sheetBody } from "./sheetKeysFixtures"
import { budget } from "./timing"

function triples(result: SheetQueryResult<"find">): number[][] {
	const out: number[][] = []

	for (let i = 0; i + 2 < result.cells.length; i += 3)
		out.push([result.cells[i] ?? 0, result.cells[i + 1] ?? 0, result.cells[i + 2] ?? 0])

	return out
}

const plain = { matchCase: false, wholeCell: false }

describe("find matching", () => {
	it("finds text anywhere in a cell, ignoring case unless asked", () => {
		const matcher = findMatcher("Apple", plain)

		expect(matcher?.test("green APPLES")).toBe(true)
		expect(matcher?.test("pear")).toBe(false)
		expect(findMatcher("Apple", { matchCase: true, wholeCell: false })?.test("green apples")).toBe(false)
	})

	it("matches the whole cell only when asked", () => {
		const matcher = findMatcher("apple", { matchCase: false, wholeCell: true })

		expect(matcher?.test("Apple")).toBe(true)
		expect(matcher?.test("apples")).toBe(false)
	})

	it("reads ? as one character, * as any run, and ~ as making the next literal", () => {
		expect(findMatcher("s?t", plain)?.test("a sat b")).toBe(true)
		expect(findMatcher("s?t", plain)?.test("st")).toBe(false)
		expect(findMatcher("s*d", { matchCase: false, wholeCell: true })?.test("sad")).toBe(true)
		expect(findMatcher("s*d", { matchCase: false, wholeCell: true })?.test("started")).toBe(true)
		expect(findMatcher("s*d", { matchCase: false, wholeCell: true })?.test("starts")).toBe(false)
		expect(findMatcher("fy91~?", plain)?.test("fy91?")).toBe(true)
		expect(findMatcher("fy91~?", plain)?.test("fy912")).toBe(false)
		expect(findMatcher("~*", plain)?.test("a*b")).toBe(true)
		expect(findMatcher("~*", plain)?.test("ab")).toBe(false)
		expect(findMatcher("a~~b", plain)?.test("a~b")).toBe(true)
	})

	it("finds nothing for an empty search", () => {
		expect(findMatcher("", plain)).toBeNull()
	})

	it("replaces every match, leftmost first and as long as it goes", () => {
		expect(findMatcher("an", plain)?.replace("Banana", "AN")).toBe("BANANa")
		expect(findMatcher("a*", plain)?.replace("xabcabc", "Z")).toBe("xZ")
		expect(findMatcher("?", plain)?.replace("abc", "x")).toBe("xxx")
		expect(findMatcher("*", plain)?.replace("abc", "x")).toBe("x")
		expect(findMatcher("b?d", plain)?.replace("bad bid bud", "-")).toBe("- - -")
		expect(findMatcher("q", plain)?.replace("abc", "x")).toBeNull()
		// The text outside a match keeps its case.
		expect(findMatcher("B", plain)?.replace("AbC", "x")).toBe("AxC")
	})

	it("replaces the whole cell when it must match whole", () => {
		const matcher = findMatcher("cat", { matchCase: false, wholeCell: true })

		expect(matcher?.replace("Cat", "dog")).toBe("dog")
		expect(matcher?.replace("cats", "dog")).toBeNull()
	})

	it("keeps offsets when lower case changes a character's length", () => {
		expect(foldText("İx").length).toBe(2)
		expect(findMatcher("x", plain)?.replace("İxİ", "y")).toBe("İyİ")
	})

	it("searches for the whole of a text longer than 255 characters", () => {
		const head = "a".repeat(255)
		const text = `${head}${"b".repeat(45)}`
		const matcher = findMatcher(text, plain)

		expect(matcher?.test(`x${text}y`)).toBe(true)
		expect(matcher?.test(`${head}${"c".repeat(45)}`)).toBe(false)
		expect(matcher?.replace(`x${text}y`, "Z")).toBe("xZy")
		expect(matcher?.replace(`${head}c`, "Z")).toBeNull()
	})

	it("keeps a ~ escape that straddles the 255th character", () => {
		const matcher = findMatcher(`${"a".repeat(254)}~*b`, plain)

		expect(matcher?.test(`${"a".repeat(254)}*b`)).toBe(true)
		expect(matcher?.test(`${"a".repeat(254)}xb`)).toBe(false)
		expect(matcher?.test(`${"a".repeat(254)}~`)).toBe(false)
	})

	it("agrees with a reference reading of the wildcards on random patterns and texts", () => {
		const letters = "ab*?~"
		let seed = 7
		const random = (n: number): number => {
			seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648

			return seed % n
		}
		const pick = (length: number, from: string): string => Array.from({ length }, () => from.charAt(random(from.length))).join("")
		// The reference: the pattern as a regular expression (test-only; the matcher itself never builds one).
		const reference = (pattern: string, whole: boolean): RegExp => {
			let source = ""

			for (let i = 0; i < pattern.length; i++) {
				const char = pattern.charAt(i)

				if (char === "~" && i + 1 < pattern.length && "*?~".includes(pattern.charAt(i + 1))) source += `\\${pattern.charAt(++i)}`
				else if (char === "*") source += "[\\s\\S]*"
				else if (char === "?") source += "[\\s\\S]"
				else source += char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
			}

			return new RegExp(whole ? `^(?:${source})$` : source, "s")
		}

		for (let n = 0; n < 3_000; n++) {
			const pattern = pick(1 + random(5), letters)
			const text = pick(random(9), "ab*?~")
			const whole = random(2) === 1

			expect(findMatcher(pattern, { matchCase: true, wholeCell: whole })?.test(text), `${pattern} ${text} ${String(whole)}`).toBe(
				reference(pattern, whole).test(text)
			)
		}
	})

	it("stays linear on a pattern that would make a backtracking matcher blow up", () => {
		const text = "a".repeat(32_767)
		const started = performance.now()

		expect(findMatcher("*a*a*a*a*a*a*a*a*b", plain)?.test(text)).toBe(false)
		expect(findMatcher("a*a*a*a*b", plain)?.replace(text, "x")).toBeNull()
		expect(performance.now() - started).toBeLessThan(budget(5_000))
	})
})

async function find(
	session: SheetSessionApi,
	request: Partial<Parameters<SheetSessionApi["query"]>[1] & object> & { text: string }
): Promise<SheetQueryResult<"find">> {
	return session.query("find", {
		scope: "workbook",
		matchCase: false,
		wholeCell: false,
		lookIn: "values",
		limit: 100,
		...request
	} as never)
}

const BOOK = {
	sheets: [
		{
			name: "One",
			body: sheetBody([
				["apple", 2, { f: 'A1&"pie"', v: "applepie" }],
				["Pear", { f: "SUM(B1:B1)", v: 2 }, null],
				[null, "pineapple", 12_345.5]
			])
		},
		{ name: "Two", body: sheetBody([["APPLE tart"], [null, { f: "1+1", v: 2 }]]) },
		{ name: "Three", body: sheetBody([["apple"]]) }
	]
}

describe("the find query", () => {
	it("goes row by row from the cell after `from`, through the other sheets, and round to `from`", async () => {
		const { session } = await openKeys(BOOK)

		const all = await find(session, { text: "apple", from: { sheet: 0, row: 0, col: 0 } })

		// One!C1 shows "applepie"; One!B3 "pineapple"; Two!A1; Three!A1; then One!A1 last.
		expect(triples(all)).toEqual([
			[0, 0, 2],
			[0, 2, 1],
			[1, 0, 0],
			[2, 0, 0],
			[0, 0, 0]
		])
		expect(all.more).toBe(false)
	})

	it("starts at `from` itself when asked, and goes round to the cell before it", async () => {
		const { session } = await openKeys(BOOK)

		expect(triples(await find(session, { text: "apple", from: { sheet: 0, row: 0, col: 2 }, start: "at" }))).toEqual([
			[0, 0, 2],
			[0, 2, 1],
			[1, 0, 0],
			[2, 0, 0],
			[0, 0, 0]
		])
		// From the first cell of a sheet: that cell first, then on.
		expect(triples(await find(session, { text: "apple", from: { sheet: 1, row: 0, col: 0 }, start: "at" }))).toEqual([
			[1, 0, 0],
			[2, 0, 0],
			[0, 0, 0],
			[0, 0, 2],
			[0, 2, 1]
		])
	})

	it("lists the matches before `from` when asked, the nearest last, keeping the last `limit` of them", async () => {
		const { session } = await openKeys(BOOK)
		const all = await find(session, { text: "apple", from: { sheet: 1, row: 0, col: 0 }, start: "before" })

		// `from` itself (Two!A1) comes first: the walk at it, round to the cell before it.
		expect(triples(all)).toEqual([
			[1, 0, 0],
			[2, 0, 0],
			[0, 0, 0],
			[0, 0, 2],
			[0, 2, 1]
		])
		expect(all.more).toBe(false)

		const last = await find(session, { text: "apple", from: { sheet: 1, row: 0, col: 0 }, start: "before", limit: 2 })

		expect(triples(last)).toEqual([
			[0, 0, 2],
			[0, 2, 1]
		])
		expect(last.more).toBe(true)
		// Within a selection, the same.
		expect(
			triples(
				await find(session, {
					text: "e",
					scope: { sheet: 0 },
					within: [{ startRow: 0, startCol: 0, endRow: 2, endCol: 2 }],
					from: { sheet: 0, row: 1, col: 0 },
					start: "before"
				})
			)
		).toEqual([
			[0, 1, 0],
			[0, 2, 1],
			[0, 0, 0],
			[0, 0, 2]
		])
	})

	it("answers the session version the matches reflect", async () => {
		const { session } = await openKeys(BOOK)
		const before = await find(session, { text: "apple" })
		const edit = await session.command({
			type: "cells.set",
			sheet: 1,
			cells: { rows: Uint32Array.of(5), cols: Uint16Array.of(0), inputs: ["apple"] }
		})
		const after = await find(session, { text: "apple" })

		expect(edit.ok && edit.change.state.version).toBe(after.version)
		expect(after.version).toBeGreaterThan(before.version)
		expect(triples(after)).toContainEqual([1, 5, 0])
	})

	it("searches only the selection's ranges when given them", async () => {
		const { session } = await openKeys(BOOK)
		const within = [
			{ startRow: 1, startCol: 0, endRow: 3, endCol: 0 },
			{ startRow: 2, startCol: 1, endRow: 2, endCol: 1 }
		]

		// One!A2 ("Pear") and One!B3 ("pineapple") are in it; One!A1 and C1 are not, nor other sheets.
		expect(triples(await find(session, { text: "apple", scope: { sheet: 0 }, within }))).toEqual([[0, 2, 1]])
		expect(triples(await find(session, { text: "e", scope: { sheet: 0 }, within, from: { sheet: 0, row: 2, col: 1 } }))).toEqual([
			[0, 1, 0],
			[0, 2, 1]
		])
		// A workbook search ignores them.
		expect(triples(await find(session, { text: "apple", within })).length).toBe(5)
	})

	it("searches one sheet when scoped to it", async () => {
		const { session } = await openKeys(BOOK)

		expect(triples(await find(session, { text: "apple", scope: { sheet: 1 } }))).toEqual([[1, 0, 0]])
	})

	it("stops at the limit and says there is more", async () => {
		const { session } = await openKeys(BOOK)
		const first = await find(session, { text: "apple", limit: 2 })

		expect(triples(first)).toEqual([
			[0, 0, 0],
			[0, 0, 2]
		])
		expect(first.more).toBe(true)
	})

	it("matches values as shown and formulas as typed", async () => {
		const { session } = await openKeys(BOOK)

		expect(triples(await find(session, { text: "SUM", lookIn: "values" }))).toEqual([])
		expect(triples(await find(session, { text: "SUM", lookIn: "formulas" }))).toEqual([[0, 1, 1]])
		// 12,345.5 in General shows "12345.5"; a formula's result is found by its value.
		expect(triples(await find(session, { text: "345.5" }))).toEqual([[0, 2, 2]])
		expect(triples(await find(session, { text: "2", lookIn: "values", wholeCell: true }))).toEqual([
			[0, 0, 1],
			[0, 1, 1],
			[1, 1, 1]
		])
		expect(triples(await find(session, { text: "2", lookIn: "formulas", wholeCell: true }))).toEqual([[0, 0, 1]])
	})

	it("honours match case and whole cell", async () => {
		const { session } = await openKeys(BOOK)

		expect(triples(await find(session, { text: "APPLE", matchCase: true }))).toEqual([[1, 0, 0]])
		expect(triples(await find(session, { text: "apple", wholeCell: true }))).toEqual([
			[0, 0, 0],
			[2, 0, 0]
		])
	})

	it("passes over hidden sheets in a workbook search", async () => {
		const files = unzipSync(
			buildFixture({
				sheets: [
					{ name: "One", body: sheetBody([["apple"]]) },
					{ name: "Two", body: sheetBody([["apple"]]) }
				]
			})
		)

		files["xl/workbook.xml"] = strToU8(
			strFromU8(files["xl/workbook.xml"] as Uint8Array).replace('sheetId="2"', 'sheetId="2" state="hidden"')
		)

		const { session } = await openKeys(zipSync(files))

		expect(triples(await find(session, { text: "apple" }))).toEqual([[0, 0, 0]])
	})

	it("searches a text file's cells as typed", async () => {
		const { session } = await openKeys("name,qty\napple,3\nPineapple,=1+2\n")

		expect(triples(await find(session, { text: "apple", from: { sheet: 0, row: 1, col: 0 } }))).toEqual([
			[0, 2, 0],
			[0, 1, 0]
		])
		expect(triples(await find(session, { text: "=1", lookIn: "values" }))).toEqual([[0, 2, 1]])
	})

	it("gives the in-thread host a turn while it walks, and stops when aborted", async () => {
		const rows = Array.from({ length: 5_000 }, (_, row) => [`cell ${String(row)}`])
		let pauses = 0
		let now = 0
		const slicing = {
			sliceMs: 1,
			now: () => (now += 1),
			pause: () => {
				pauses++

				return Promise.resolve()
			}
		}
		const { session } = await openKeys({ sheets: [{ name: "One", body: sheetBody(rows) }] }, { slicing })

		pauses = 0

		const found = await find(session, { text: "4999" })

		expect(triples(found)).toEqual([[0, 4_999, 0]])
		expect(pauses).toBeGreaterThan(0)

		await expect(
			session.query(
				"find",
				{ scope: "workbook", text: "x", matchCase: false, wholeCell: false, lookIn: "values", limit: 1 },
				{ signal: { aborted: true } }
			)
		).rejects.toThrow()
	})
})

describe("find.replace", () => {
	it("replaces in every match of the workbook as one step, which undo takes back whole", async () => {
		const { session } = await openKeys(BOOK)
		const result = await session.command({
			type: "find.replace",
			scope: "workbook",
			text: "apple",
			replacement: "plum",
			matchCase: false,
			wholeCell: false
		})

		expect(result.ok).toBe(true)
		expect(tileEntry(await firstTile(session, 0), 0, 0)?.text).toBe("plum")
		expect(tileEntry(await firstTile(session, 0), 2, 1)?.text).toBe("pineplum")
		expect(tileEntry(await firstTile(session, 1), 0, 0)?.text).toBe("plum tart")
		// A formula is replaced in its text, not its value: C1 is =A1&"pie" and now shows "plumpie".
		expect(tileEntry(await firstTile(session, 0), 0, 2)?.text).toBe("plumpie")

		await session.undo()

		expect(tileEntry(await firstTile(session, 0), 0, 0)?.text).toBe("apple")
		expect(tileEntry(await firstTile(session, 1), 0, 0)?.text).toBe("APPLE tart")

		const state = await session.markSaved(0)

		expect(state.canUndo).toBe(false)
	})

	it("replaces the whole of a search text longer than 255 characters", async () => {
		const head = "a".repeat(255)
		const text = `${head}${"b".repeat(45)}`
		const { session } = await openKeys({ sheets: [{ name: "One", body: sheetBody([[`${text}!`], [`${head}${"c".repeat(45)}`]]) }] })

		await session.command({ type: "find.replace", scope: "workbook", text, replacement: "Z", matchCase: false, wholeCell: false })

		expect(tileEntry(await firstTile(session, 0), 0, 0)?.text).toBe("Z!")
		expect(tileEntry(await firstTile(session, 0), 1, 0)?.text).toBe(`${head}${"c".repeat(45)}`)
	})

	it("replaces in the given cell only (Replace on the current match)", async () => {
		const { session } = await openKeys(BOOK)

		await session.command({
			type: "find.replace",
			scope: "workbook",
			text: "apple",
			replacement: "plum",
			matchCase: false,
			wholeCell: false,
			cells: Uint32Array.of(1, 0, 0)
		})

		expect(tileEntry(await firstTile(session, 1), 0, 0)?.text).toBe("plum tart")
		expect(tileEntry(await firstTile(session, 0), 0, 0)?.text).toBe("apple")
	})

	it("replaces only within the selection", async () => {
		const { session } = await openKeys(BOOK)

		await session.command({
			type: "find.replace",
			scope: { sheet: 0 },
			text: "apple",
			replacement: "plum",
			matchCase: false,
			wholeCell: false,
			within: [{ startRow: 1, startCol: 0, endRow: 3, endCol: 2 }]
		})

		expect(tileEntry(await firstTile(session, 0), 0, 0)?.text).toBe("apple")
		expect(tileEntry(await firstTile(session, 0), 2, 1)?.text).toBe("pineplum")
		expect(tileEntry(await firstTile(session, 1), 0, 0)?.text).toBe("APPLE tart")
	})

	it("writes each changed cell as if typed again, as Excel does", async () => {
		const { session } = await openKeys({ sheets: [{ name: "One", body: sheetBody([["abc1"]]) }] })

		await session.command({ type: "find.replace", scope: "workbook", text: "abc", replacement: "", matchCase: false, wholeCell: false })

		const entry = tileEntry(await firstTile(session, 0), 0, 0)

		expect(entry?.text).toBe("1")
		expect((entry?.flags ?? 0) & CellFlag.NUMBER).not.toBe(0)
	})

	it("refuses over locked cells of a protected sheet", async () => {
		const { session } = await openKeys({
			sheets: [{ name: "One", body: `${sheetBody([["apple"]])}<sheetProtection sheet="1"/>` }]
		})
		const result = await session.command({
			type: "find.replace",
			scope: "workbook",
			text: "apple",
			replacement: "plum",
			matchCase: false,
			wholeCell: false
		})

		expect(result.ok).toBe(false)
		expect(!result.ok && result.refusal.reason).toBe("protectedSheet")
	})

	it("changes nothing when nothing matches", async () => {
		const { session } = await openKeys(BOOK)
		const result = await session.command({
			type: "find.replace",
			scope: "workbook",
			text: "zzz",
			replacement: "plum",
			matchCase: false,
			wholeCell: false
		})

		expect(result.ok).toBe(true)
		expect(result.ok ? result.change.state.canUndo : null).toBe(false)
	})

	it("replaces in a text file and undoes", async () => {
		const { session } = await openKeys("a,b\napple,apple pie\n")

		await session.command({
			type: "find.replace",
			scope: "workbook",
			text: "apple",
			replacement: "fig",
			matchCase: false,
			wholeCell: false
		})

		const tile = await firstTile(session, 0)

		expect(tileEntry(tile, 1, 0)?.text).toBe("fig")
		expect(tileEntry(tile, 1, 1)?.text).toBe("fig pie")

		await session.undo()

		expect(tileEntry(await firstTile(session, 0), 1, 1)?.text).toBe("apple pie")
	})
})
