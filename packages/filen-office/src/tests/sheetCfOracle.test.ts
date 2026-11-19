import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate"
import { AxisFlag, TILE_COLS, TILE_ROWS, type SheetRange, type SheetRenderStyle, type SheetTile } from "../core/sheet/protocol"
import { parseSqref } from "../core/xlsx/refs/sqref"
import { inThreadSheetHost } from "../dom/sheet/host"
import { CORPUS_DIR } from "./corpusDir"
import { exportShown, sheetOffices, sheetProfile } from "./oracles/sheet/libreOffice"
import { IMMEDIATE } from "./sheetCfFixtures"

// Conditional formats against LibreOffice: over every corpus workbook with conditional formatting, the fill each cell
// of a rule's range shows in LibreOffice's HTML export (26.8 applies colour scales there too; 7.5 only rule fills)
// equals the fill of our tile's look. Opt-in: FILEN_OFFICE_SOFFICE=<soffice>; skips without it. Prints the
// agreement and each file's mismatches.

const INSTALLS = sheetOffices().filter(office => {
	const [major = 0, minor = 0] = office.version.split(".").map(Number)

	return major > 26 || (major === 26 && minor >= 8)
})
// Cells compared per sheet at most (a rule over whole columns is compared over the used area, this far).
const MAX_CELLS = 40_000
const TIMEOUT_MS = 120_000

function workbooks(): string[] {
	const found: string[] = []
	const walk = (directory: string): void => {
		for (const name of readdirSync(directory)) {
			const path = join(directory, name)

			if (statSync(path).isDirectory()) walk(path)
			else if (/\.(xlsx|xlsm|xltx|xltm)$/iu.test(name)) found.push(path)
		}
	}

	walk(CORPUS_DIR)

	return found.filter(path => {
		try {
			const files = unzipSync(readFileSync(path), { filter: file => /^xl\/worksheets\/sheet\d+\.xml$/u.test(file.name) })

			return Object.values(files).some(bytes => strFromU8(bytes).includes("cfRule"))
		} catch {
			return false
		}
	})
}

const hex = (rgb: number | undefined): string | undefined =>
	rgb === undefined ? undefined : `#${rgb.toString(16).padStart(6, "0").toUpperCase()}`

describe.skipIf(INSTALLS.length === 0 || !existsSync(CORPUS_DIR))("conditional formats against LibreOffice", () => {
	let scratch: string

	beforeAll(() => {
		scratch = mkdtempSync(join(tmpdir(), "filen-cf-oracle-"))
	})

	afterAll(() => {
		rmSync(scratch, { recursive: true, force: true })
	})

	it(
		"fills every rule's cells as LibreOffice's HTML export does",
		async () => {
			const office = INSTALLS[0] as (typeof INSTALLS)[number]
			const files = workbooks().map((file, index) => unhidden(file, join(scratch, "unhidden", `${String(index)}-${basename(file)}`)))
			const profile = sheetProfile(scratch, "cf")
			const shown = await exportShown(office, profile, files, join(scratch, "out"), TIMEOUT_MS)
			let compared = 0
			let agreed = 0
			let skipped = 0
			const report: string[] = []

			for (const [index, file] of files.entries()) {
				const lo = shown[index]

				if (lo === undefined || !lo.ok) {
					report.push(`${basename(file)}: LibreOffice failed (${lo?.error ?? "?"})`)
					continue
				}

				const host = inThreadSheetHost()
				const opened = await host.open(
					readFileSync(file),
					{ kind: "xlsx", slicing: IMMEDIATE, settings: { clock: () => Date.now() } },
					() => undefined
				)

				if (opened.kind !== "opened") {
					report.push(`${basename(file)}: not opened (${opened.kind})`)
					continue
				}

				const styles: SheetRenderStyle[] = []
				const add = (append: { from: number; styles: readonly SheetRenderStyle[] } | undefined): void => {
					append?.styles.forEach((style, k) => {
						styles[append.from + k] = style
					})
				}
				const parts = unzipSync(readFileSync(file))

				add(opened.info.styles)

				// Every sheet parsed, and what the formats wait for (rules reading other sheets) landed.
				// (A sheet that cannot be read is left out.)
				for (const summary of opened.info.sheets)
					if (summary.kind === "worksheet") await opened.session.layout(summary.id).catch(() => undefined)

				await new Promise(resolve => setTimeout(resolve, 20))

				for (const summary of opened.info.sheets) {
					if (summary.kind !== "worksheet") continue

					const sheetFills = lo.sheets.find(sheet => sheet.name === summary.name)?.fills

					if (sheetFills === undefined) continue

					const layout = await opened.session.layout(summary.id).catch(() => null)

					if (layout === null) continue

					// LibreOffice's HTML leaves hidden rows and columns out, so its table no longer lines up with A1 past them
					// (rows and columns hidden by an outline or a filter the copies cannot show).
					const hidden = [...layout.rows.flags, ...layout.cols.flags].some(flags => (flags & AxisFlag.HIDDEN) !== 0)

					if (hidden) {
						skipped++
						continue
					}

					// A merge shows its first cell's look (LibreOffice's HTML: one cell spanning the merge).
					const covered = (row: number, col: number): boolean => {
						for (let k = 0; k + 3 < layout.merges.length; k += 4) {
							const startRow = layout.merges[k] ?? 0
							const startCol = layout.merges[k + 1] ?? 0

							if (
								row >= startRow &&
								row <= (layout.merges[k + 2] ?? 0) &&
								col >= startCol &&
								col <= (layout.merges[k + 3] ?? 0)
							)
								return row !== startRow || col !== startCol
						}

						return false
					}
					// The rule ranges, from the part (2007 and x14 sqrefs).
					const ranges = cfRanges(summary.name, parts)

					let cells = 0
					const tiles = new Map<string, SheetTile>()
					const tileOf = async (row: number, col: number): Promise<SheetTile> => {
						const key = `${String(Math.floor(row / TILE_ROWS))},${String(Math.floor(col / TILE_COLS))}`
						let tile = tiles.get(key)

						if (tile === undefined) {
							const fetched = await opened.session.tiles(
								summary.id,
								Uint32Array.of(Math.floor(row / TILE_ROWS), Math.floor(col / TILE_COLS))
							)

							add(fetched.styles)
							tile = fetched.tiles[0] as SheetTile
							tiles.set(key, tile)
						}

						return tile
					}
					const mismatches: string[] = []

					for (const range of ranges) {
						for (let row = range.startRow; row <= Math.min(range.endRow, layout.rowCount - 1) && cells < MAX_CELLS; row++) {
							for (let col = range.startCol; col <= Math.min(range.endCol, layout.colCount - 1) && cells < MAX_CELLS; col++) {
								if (covered(row, col)) continue

								const tile = await tileOf(row, col)
								const position = ((row % TILE_ROWS) << 5) | (col % TILE_COLS)
								const entry = tile.positions.indexOf(position)
								const style = entry < 0 ? undefined : styles[tile.styles[entry] ?? 0]
								const ours = hex(style?.fill)
								const theirs = sheetFills.get(`${String(row)},${String(col)}`)
								// A cell without an entry shows its row's or column's style; compare only what the tiles say. A
								// pattern fill LibreOffice exports as a colour of its own: not compared.
								const known = (entry >= 0 || theirs === undefined) && style?.pattern === undefined

								if (!known) continue

								cells++
								compared++

								if ((ours ?? "#FFFFFF") === (theirs ?? "#FFFFFF")) agreed++
								else if (mismatches.length < 5)
									mismatches.push(`${String(row + 1)}:${String(col + 1)} ours ${ours ?? "-"} lo ${theirs ?? "-"}`)
							}
						}
					}

					if (mismatches.length > 0) report.push(`${basename(file)} [${summary.name}]: ${mismatches.join("; ")}`)
				}

				opened.session.close()
				host.dispose()
			}

			console.log(
				`conditional fills: ${String(agreed)}/${String(compared)} agree (${((100 * agreed) / Math.max(1, compared)).toFixed(3)} %); ${String(skipped)} sheets with hidden rows or columns not compared`
			)
			console.log(report.join("\n"))
			expect(compared).toBeGreaterThan(0)
			expect(agreed / compared).toBeGreaterThanOrEqual(0.99)
		},
		30 * 60_000
	)
})

// A copy of a workbook with its rows and columns near the data shown (hiding does not change what a rule gives;
// LibreOffice's HTML leaves hidden ones out). Sheets that keep some hidden are not compared.
function unhidden(file: string, copy: string): string {
	const parts = unzipSync(readFileSync(file))

	for (const name of Object.keys(parts)) {
		if (!/^xl\/worksheets\/sheet\d+\.xml$/u.test(name)) continue

		const xml = strFromU8(parts[name] ?? new Uint8Array(0))

		// Rows up to 10,000 and columns up to 256 only: unhiding the rest of the grid would make the HTML endless.
		parts[name] = strToU8(
			xml.replace(
				/<((?:\w+:)?(?:row|col))\b([^>]*?)\shidden="(?:1|true)"([^>]*)>/gu,
				(tag: string, name: string, before: string, after: string) => {
					const attributes = before + after
					const row = /\sr="(\d+)"/u.exec(attributes)?.[1]
					const max = /\smax="(\d+)"/u.exec(attributes)?.[1]
					const small = name.endsWith("row") ? Number(row ?? Infinity) <= 10_000 : Number(max ?? Infinity) <= 256

					return small ? `<${name}${before}${after}>` : tag
				}
			)
		)
	}

	mkdirSync(dirname(copy), { recursive: true })
	writeFileSync(copy, zipSync(parts))

	return copy
}

// A sheet's rule ranges from its part's sqref attributes and xm:sqref elements.
function cfRanges(sheet: string, parts: Record<string, Uint8Array>): SheetRange[] {
	const workbook = strFromU8(parts["xl/workbook.xml"] ?? new Uint8Array(0))
	const rels = strFromU8(parts["xl/_rels/workbook.xml.rels"] ?? new Uint8Array(0))
	const escaped = sheet
		.replace(/&/gu, "&amp;")
		.replace(/"/gu, "&quot;")
		.replace(/'/gu, "&apos;")
		.replace(/</gu, "&lt;")
		.replace(/>/gu, "&gt;")
	const tag = [...workbook.matchAll(/<(?:\w+:)?sheet\b[^>]*>/gu)].map(match => match[0]).find(text => text.includes(`name="${escaped}"`))
	const id = /\br:id="([^"]+)"/u.exec(tag ?? "")?.[1]
	const target = new RegExp(`Id="${id ?? "-"}"[^>]*Target="([^"]+)"|Target="([^"]+)"[^>]*Id="${id ?? "-"}"`, "u").exec(rels)
	const path = (target?.[1] ?? target?.[2] ?? "").replace(/^\/?xl\//u, "").replace(/^\//u, "")
	const xml = strFromU8(parts[`xl/${path}`] ?? new Uint8Array(0))

	return [
		...[...xml.matchAll(/<(?:\w+:)?conditionalFormatting\b[^>]*\ssqref="([^"]+)"/gu)].flatMap(
			match => parseSqref(match[1] ?? "") ?? []
		),
		...[...xml.matchAll(/<xm:sqref>([^<]+)<\/xm:sqref>/gu)]
			.filter(
				match => xml.lastIndexOf("<x14:conditionalFormatting", match.index) > xml.lastIndexOf("<x14:dataValidation", match.index)
			)
			.flatMap(match => parseSqref(match[1] ?? "") ?? [])
	]
}
