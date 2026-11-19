import { existsSync, readFileSync } from "node:fs"
import { MessageChannel, type MessagePort } from "node:worker_threads"
import { dirname, join } from "node:path"
import { describe, expect, it } from "vitest"
import type { SheetChange, SheetCommandResult, SheetFileKind, SheetSessionApi } from "../core/sheet/protocol"
import { openTextSession } from "../core/sheet/text"
import { sheetWorkerHost, type SheetWorkerLike } from "../dom/sheet/client"
import { serveTextWorker } from "../dom/sheet/text"
import { cells, firstTile, numeric, savedBytes, tileEntry, tileTexts } from "./sheetSessionFixtures"
import { equalBytes } from "./xlsxWriteFixtures"

// CSV, TSV and .tab files as sessions: text stored as typed, the file written back in its own encoding, separator
// and line ends, an unedited (or undone) save as the source byte for byte; and the text path's imports, which
// never reach the workbook stack or the formula engine.

async function open(bytes: Uint8Array, kind: SheetFileKind = "csv"): Promise<SheetSessionApi> {
	const opened = await openTextSession(bytes, { kind }, () => undefined)

	if (opened.kind !== "opened") throw new Error(opened.kind)

	return opened.session
}

function changeOf(result: SheetCommandResult): SheetChange {
	if (!result.ok) throw new Error(result.refusal.reason)

	return result.change
}

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text)

describe("text sessions", () => {
	it("shows text as stored, numbers on the right, and saves an unedited file as its source", async () => {
		const bytes = utf8('name;value\r\n"a;b";007\r\nx;1,5\r\n')
		const session = await open(bytes)
		const tile = await firstTile(session, 0)

		expect(tileTexts(tile).get("1,0")).toBe("a;b")
		expect(tileTexts(tile).get("1,1")).toBe("007")
		expect(numeric(tileEntry(tile, 2, 1)?.flags ?? 0)).toBe(true)
		expect(equalBytes(await savedBytes(session), bytes)).toBe(true)
		session.close()
	})

	it("stores a typed formula as its text, and writes the file in its own separator and line ends", async () => {
		const bytes = utf8("a\tb\nc\td\n")
		const session = await open(bytes, "tsv")
		const change = changeOf(
			await session.command({
				type: "cells.set",
				sheet: 0,
				cells: cells([
					[0, 1, "=1+1"],
					[2, 0, "'x"]
				])
			})
		)

		expect(change.state.dirty).toBe(true)
		expect(new TextDecoder().decode(await savedBytes(session))).toBe("a\t=1+1\nc\td\n'x\n")
		session.close()
	})

	it("refuses a character a windows-1252 file cannot hold", async () => {
		const bytes = Uint8Array.of(0x63, 0x61, 0x66, 0xe9, 0x2c, 0x31, 0x0a)
		const session = await open(bytes)

		expect(tileTexts(await firstTile(session, 0)).get("0,0")).toBe("café")

		const result = await session.command({ type: "cells.set", sheet: 0, cells: cells([[0, 1, "€ and ✓"]]) })

		expect(result.ok ? null : result.refusal.reason).toBe("encoding")
		expect(equalBytes(await savedBytes(session), bytes)).toBe(true)
		session.close()
	})

	it("inserts and deletes rows and columns, and undone edits save as the source", async () => {
		const bytes = utf8("a,b,c\r\nd,e,f\r\ng,h,i\r\n")
		const session = await open(bytes)

		changeOf(await session.command({ type: "axis.delete", sheet: 0, axis: "rows", at: 0, count: 1 }))
		changeOf(await session.command({ type: "axis.insert", sheet: 0, axis: "cols", at: 1, count: 2 }))
		expect(new TextDecoder().decode(await savedBytes(session))).toBe("d,,,e,f\r\ng,,,h,i\r\n")

		const past = changeOf(await session.command({ type: "axis.insert", sheet: 0, axis: "rows", at: 50, count: 1 }))

		expect(past.state.version).toBeGreaterThan(0)
		changeOf(await session.undo())
		changeOf(await session.undo())
		expect(equalBytes(await savedBytes(session), bytes)).toBe(true)
		session.close()
	})

	it("pastes text and moves a cut", async () => {
		const session = await open(utf8("a,b\r\nc,d\r\n"))
		const copied = await session.query("copy", { sheet: 0, range: { startRow: 0, startCol: 0, endRow: 0, endCol: 1 }, cut: true })

		if ("refused" in copied) throw new Error("refused")

		changeOf(await session.command({ type: "clipboard.paste", sheet: 0, at: { row: 2, col: 0 }, text: copied.text, clip: copied.clip }))
		expect(new TextDecoder().decode(await savedBytes(session))).toBe(",\r\nc,d\r\na,b\r\n")
		session.close()
	})

	it("moves a cut over a block it overlaps, and undo puts the file back", async () => {
		const bytes = utf8("a,b,c\r\nd,e,f\r\n")
		const session = await open(bytes)
		const copied = await session.query("copy", { sheet: 0, range: { startRow: 0, startCol: 0, endRow: 1, endCol: 1 }, cut: true })

		if ("refused" in copied) throw new Error("refused")

		changeOf(await session.command({ type: "clipboard.paste", sheet: 0, at: { row: 1, col: 1 }, text: copied.text, clip: copied.clip }))
		expect(new TextDecoder().decode(await savedBytes(session))).toBe(",,c\r\n,a,b\r\n,d,e\r\n")
		changeOf(await session.undo())
		expect(equalBytes(await savedBytes(session), bytes)).toBe(true)
		session.close()
	})

	// A block `rows` by `cols`, every field filled.
	const block = (rows: number, cols: number): Uint8Array =>
		utf8(
			Array.from({ length: rows }, (_, row) =>
				Array.from({ length: cols }, (_, col) => `${String(row)}.${String(col)}`).join(",")
			).join("\n") + "\n"
		)

	it("moves a 100,000-cell cut, and undo puts it back", async () => {
		const bytes = block(10_000, 10)
		const session = await open(bytes)
		const copied = await session.query("copy", { sheet: 0, range: { startRow: 0, startCol: 0, endRow: 9_999, endCol: 9 }, cut: true })

		if ("refused" in copied) throw new Error("refused")

		changeOf(
			await session.command({ type: "clipboard.paste", sheet: 0, at: { row: 0, col: 10 }, text: copied.text, clip: copied.clip })
		)

		const tile = await firstTile(session, 0)

		expect(tileTexts(tile).get("0,0")).toBeUndefined()
		expect(tileTexts(tile).get("0,10")).toBe("0.0")
		changeOf(await session.undo())
		expect(equalBytes(await savedBytes(session), bytes)).toBe(true)
		session.close()
	})

	it("refuses a cut whose emptied and pasted cells pass what one edit may name, writing nothing", async () => {
		const bytes = block(15_000, 10)
		const session = await open(bytes)
		const copied = await session.query("copy", { sheet: 0, range: { startRow: 0, startCol: 0, endRow: 14_999, endCol: 9 }, cut: true })

		if ("refused" in copied) throw new Error("refused")

		const result = await session.command({
			type: "clipboard.paste",
			sheet: 0,
			at: { row: 0, col: 10 },
			text: copied.text,
			clip: copied.clip
		})

		expect(result.ok ? null : result.refusal.reason).toBe("tooLarge")
		expect(equalBytes(await savedBytes(session), bytes)).toBe(true)
		session.close()
	})

	it("refuses formats and sizes, which a text file does not hold", async () => {
		const session = await open(utf8("a\n"))
		const format = await session.command({
			type: "format.apply",
			sheet: 0,
			ranges: [{ startRow: 0, startCol: 0, endRow: 0, endCol: 0 }],
			patch: { bold: true }
		})

		expect(format.ok ? null : format.refusal.reason).toBe("unsupported")
		session.close()
	})

	it("runs in a text worker", async () => {
		const { port1, port2 } = new MessageChannel()
		const page: SheetWorkerLike = {
			postMessage: (message, transfer) => port1.postMessage(message, transfer ?? []),
			addEventListener: (type, listener) => {
				if (type === "message") port1.on("message", (data: unknown) => listener({ data }))
			}
		}

		serveTextWorker({
			post: (message, transfer) => port2.postMessage(message, [...transfer]),
			listen: onMessage => {
				port2.on("message", onMessage)
			}
		})

		const host = sheetWorkerHost(page)
		const result = await host.open(utf8("1,2\n"), { kind: "csv" }, () => undefined)

		if (result.kind !== "opened") throw new Error(result.kind)

		changeOf(await result.session.command({ type: "cells.set", sheet: 0, cells: cells([[0, 0, "3"]]) }))
		expect(new TextDecoder().decode(await savedBytes(result.session))).toBe("3,2\n")

		const workbook = await host.open(utf8("PK"), { kind: "xlsx" }, () => undefined)

		expect(workbook).toMatchObject({ kind: "failed", reason: "unsupported" })
		host.dispose()
		;(port1 as MessagePort).close()
		;(port2 as MessagePort).close()
	})
})

// A file the heuristic misdetects as writable windows-1252 (its true source encoding is really windows-1250,
// windows-1251 or GBK) is never re-encoded on save: decode-then-encode is a bijection on every byte these sources
// use, so an untouched cell comes back byte-identical, and an edit typing a character windows-1252 cannot hold is
// refused rather than silently reformatting the whole file.
describe("text sessions over a misdetected legacy encoding", () => {
	const hexBytes = (hex: string): Uint8Array => Uint8Array.from(hex.match(/../g) ?? [], byte => Number.parseInt(byte, 16))
	// "Jméno,Město\nJiří,Brno\nZdeněk,Ústí\n" encoded as windows-1250.
	const WINDOWS_1250 = "4a6de96e6f2c4dec73746f0a4a69f8ed2c42726e6f0a5a64656eec6b2cda7374ed0a"
	// "id,unit,qty\n1,шт,5\n2,кг,3\n" encoded as windows-1251.
	const WINDOWS_1251 = "69642c756e69742c7174790a312cf8f22c350a322ceae32c330a"
	// "id,name,qty\n1,A,5\n2,B,3\n3,C,4\n4,D,1\n5,表,9\n" encoded as GBK.
	const GBK = "69642c6e616d652c7174790a312c412c350a322c422c330a332c432c340a342c442c310a352cb1ed2c390a"

	it("keeps the source byte-exact past the edited row after a representable edit", async () => {
		for (const hex of [WINDOWS_1250, WINDOWS_1251, GBK]) {
			const bytes = hexBytes(hex)
			const session = await open(bytes)

			changeOf(await session.command({ type: "cells.set", sheet: 0, cells: cells([[0, 0, "ID!"]]) }))

			const out = await savedBytes(session)

			// Only the header row's first cell was touched: every byte from the first line break on matches the source.
			expect(Array.from(out.subarray(out.indexOf(0x0a)))).toEqual(Array.from(bytes.subarray(bytes.indexOf(0x0a))))
			session.close()
		}
	})

	it("refuses an edit typing a character windows-1252 cannot hold, leaving the file's bytes unchanged", async () => {
		const cases: [string, number, number, string][] = [
			// Polish/Czech Ł is outside windows-1252 even though the file passed the heuristic.
			[WINDOWS_1250, 1, 0, "Łódź"],
			// Cyrillic is outside windows-1252.
			[WINDOWS_1251, 1, 1, "шт"],
			// Han is outside windows-1252.
			[GBK, 1, 1, "新"]
		]

		for (const [hex, row, col, typed] of cases) {
			const bytes = hexBytes(hex)
			const session = await open(bytes)
			const result = await session.command({ type: "cells.set", sheet: 0, cells: cells([[row, col, typed]]) })

			expect(result.ok ? null : result.refusal.reason).toBe("encoding")
			// Nothing was written, and no UTF-8 BOM crept in.
			expect(equalBytes(await savedBytes(session), bytes)).toBe(true)
			session.close()
		}
	})

	it("still allows a representable edit even though the true encoding differs", async () => {
		const session = await open(hexBytes(WINDOWS_1250))

		changeOf(await session.command({ type: "cells.set", sheet: 0, cells: cells([[1, 2, "Nové"]]) }))
		expect(tileTexts(await firstTile(session, 0)).get("1,2")).toBe("Nové")
		session.close()
	})
})

describe("the text path's imports", () => {
	it("never reach the workbook reader and writer, the formula engine or encryption", () => {
		const seen = new Set<string>()
		const packages = new Set<string>()
		const visit = (file: string): void => {
			if (seen.has(file)) return

			seen.add(file)

			for (const [, specifier] of readFileSync(file, "utf8").matchAll(
				/^(?:import|export)\s(?!type\b)(?:[^";]*?\sfrom\s)?"([^"]+)"/gm
			)) {
				if (specifier === undefined) continue

				if (specifier.startsWith(".")) {
					const target = join(dirname(file), specifier)

					visit(target.endsWith(".ts") ? target : existsSync(`${target}.ts`) ? `${target}.ts` : join(target, "index.ts"))
				} else {
					packages.add(specifier)
				}
			}
		}

		visit(join(import.meta.dirname, "..", "dom", "sheet", "text.ts"))

		const files = [...seen].map(file => file.slice(file.indexOf("/src/") + 5))

		expect(files).toContain("core/sheet/text.ts")
		expect(
			files.filter(
				file => file.startsWith("core/xlsx/") || file.startsWith("core/sheet/formula/") || file.startsWith("dom/encryption/")
			)
		).toEqual([])
		expect(files).not.toContain("core/sheet/commands.ts")
		expect(files).not.toContain("dom/sheet/host.ts")
		expect([...packages].sort()).toEqual([])
	})
})
