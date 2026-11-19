import { describe, expect, it } from "vitest"
import type { SheetSessionApi, SheetWorkbookInfo } from "../core/sheet/protocol"
import { exportSheetPdf, type SheetPdfRequest } from "../react/sheet/print/pdfExport"
import { nodeFontAssets, pdfBytes } from "./sheetPdfFixtures"
import { openFixture } from "./sheetSessionFixtures"
import { budget, cpuMs } from "./timing"
import { buildFixture } from "./xlsxWriteFixtures"

// A custom paper size is bounded by what a PDF page can be, and an export is cancelled within a page however much
// that page holds.

const VALUES = { date: "1/2/2026", time: "10:00", file: "big.xlsx", path: "" }

function column(index: number): string {
	return index < 26 ? String.fromCharCode(65 + index) : column(Math.floor(index / 26) - 1) + String.fromCharCode(65 + (index % 26))
}

function grid(rows: number, cols: number, pageSetup: string): string {
	const parts: string[] = []
	const letters = Array.from({ length: cols }, (_, col) => column(col))

	for (let row = 1; row <= rows; row++) {
		parts.push(`<row r="${String(row)}">`)

		for (let col = 0; col < cols; col++) parts.push(`<c r="${letters[col] ?? ""}${String(row)}"><v>${String(row * 10 + col)}</v></c>`)

		parts.push("</row>")
	}

	return `<sheetData>${parts.join("")}</sheetData><pageSetup ${pageSetup}/>`
}

async function opened(body: string): Promise<{ session: SheetSessionApi; info: SheetWorkbookInfo }> {
	const { session, info } = await openFixture(buildFixture({ sheets: [{ name: "Data", body }] }))

	for (let k = 0; k < 20; k++) await new Promise(resolve => setTimeout(resolve, 0))

	return { session, info }
}

async function request(session: SheetSessionApi, info: SheetWorkbookInfo): Promise<SheetPdfRequest> {
	const settings = await session.query("print.settings", { sheet: 0 })

	if (settings === null) throw new Error("no print settings")

	return {
		sheets: [
			{ sheet: 0, name: "Data", setup: settings.setup, ranges: settings.used === null ? [] : [settings.used], used: settings.used }
		],
		values: VALUES,
		title: "big",
		lang: "en",
		kind: info.kind,
		summaries: info.sheets,
		date1904: info.date1904,
		showFormulas: false
	}
}

describe("a sheet's PDF on a hostile paper size", () => {
	it("lays the print out on paper no larger than a PDF page may be", async () => {
		const { session, info } = await opened(grid(2_000, 10, 'paperWidth="100000in" paperHeight="100000in"'))
		const asked = await request(session, info)

		expect(asked.sheets[0]?.setup.paper).toEqual({ width: 14_400, height: 14_400 })

		const started = cpuMs()
		const result = await exportSheetPdf(asked, { session, assets: nodeFontAssets, deterministic: true })

		if (!result.ok) throw new Error(result.reason)

		const text = new TextDecoder("latin1").decode(pdfBytes(result.output.parts as never))

		for (const box of text.matchAll(/MediaBox\s*\[\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\]/g)) {
			expect(Number(box[3])).toBeLessThanOrEqual(14_400)
			expect(Number(box[4])).toBeLessThanOrEqual(14_400)
		}

		expect(result.pages).toBe(3)
		expect(cpuMs() - started).toBeLessThan(budget(10_000))
		session.close()
	}, 120_000)

	it("prints a dense page of A3 landscape at 10 %, drawn in slices", async () => {
		const { session, info } = await opened(grid(600, 260, 'paperSize="8" orientation="landscape" scale="10"'))
		const started = cpuMs()
		const result = await exportSheetPdf(await request(session, info), {
			session,
			assets: nodeFontAssets,
			deterministic: true,
			deflate: null
		})

		if (!result.ok) throw new Error(result.reason)

		const text = new TextDecoder("latin1").decode(pdfBytes(result.output.parts as never))

		// Four pages, the first about 513 rows by 233 columns (119,000 cells); a table each, a cell for every value.
		expect(result.pages).toBe(4)
		expect(text.match(/\/S\s*\/Table\b/g)).toHaveLength(4)
		expect(text.match(/\/TD <<\/MCID \d+>> BDC/g)).toHaveLength(600 * 260)
		expect(cpuMs() - started).toBeLessThan(budget(60_000))
		session.close()
	}, 300_000)

	it("prints a page of 120,000 cells on the largest paper at 10 %", async () => {
		const { session, info } = await opened(grid(1_000, 120, 'paperWidth="200in" paperHeight="200in" scale="10"'))
		const result = await exportSheetPdf(await request(session, info), { session, assets: nodeFontAssets, deterministic: true })

		expect(result.ok && result.pages).toBe(1)
		session.close()
	}, 300_000)

	it("refuses a page holding more cells than any real sheet prints on one, counting them before drawing", async () => {
		const { session, info } = await opened(grid(1_100, 2_000, 'paperWidth="200in" paperHeight="200in" scale="10"'))
		const started = cpuMs()
		const result = await exportSheetPdf(await request(session, info), { session, assets: nodeFontAssets, deterministic: true })

		expect(result).toEqual({ ok: false, reason: "pageTooLarge", pages: 1 })
		expect(cpuMs() - started).toBeLessThan(budget(30_000))
		session.close()
	}, 600_000)

	it("stops on the page it is drawing when the export is cancelled", async () => {
		const { session, info } = await opened(grid(200, 10, 'paperSize="9"'))
		const asked = await request(session, info)
		const signal = { aborted: false }
		const done: number[] = []

		const watched = new Proxy(session, {
			get(target, key, receiver) {
				if (key !== "query") return Reflect.get(target, key, receiver) as unknown

				return (name: string, ...rest: unknown[]) => {
					const answer = (target.query as (...args: unknown[]) => Promise<unknown>).call(target, name, ...rest)

					// Cancelled as the first page's cells arrive, after the read itself finished.
					return name === "print.tiles"
						? answer.then(value => {
								signal.aborted = true

								return value
							})
						: answer
				}
			}
		})

		await expect(
			exportSheetPdf(asked, {
				session: watched,
				assets: nodeFontAssets,
				deterministic: true,
				signal,
				progress: page => done.push(page)
			})
		).rejects.toThrow("aborted")
		expect(done).toEqual([])
		session.close()
	}, 120_000)

	it("hears a cancel sent as a message while a large page is drawn, between its slices", async () => {
		// One page of 600 rows by 80 columns at 10 % on A3: 48,000 cells, drawn in two slices.
		const { session, info } = await opened(grid(600, 80, 'paperSize="8" scale="10"'))
		const asked = await request(session, info)
		const signal = { aborted: false }
		let after = 0

		const watched = new Proxy(session, {
			get(target, key, receiver) {
				if (key !== "query") return Reflect.get(target, key, receiver) as unknown

				return (name: string, ...rest: unknown[]) => {
					if (name !== "print.tiles")
						return (target.query as (...args: unknown[]) => Promise<unknown>).call(target, name, ...rest)

					if (signal.aborted) after++
					// The first read of the page's cells sends the cancel, which arrives as a message would: a task later.
					else
						setTimeout(() => {
							signal.aborted = true
						}, 0)

					return (target.query as (...args: unknown[]) => Promise<unknown>).call(target, name, ...rest)
				}
			}
		})

		// A slice clock always due, its pause a task: the turns a worker gives.
		const slicing = { sliceMs: 0, now: () => 0, pause: () => new Promise<void>(resolve => setTimeout(resolve, 0)) }

		await expect(
			exportSheetPdf(asked, { session: watched, assets: nodeFontAssets, deterministic: true, signal, slicing })
		).rejects.toThrow("aborted")
		// Stopped inside the page: no slice's cells were read once the cancel arrived.
		expect(after).toBe(0)
		session.close()
	}, 120_000)

	it("draws a large page in slices to the same bytes with a slice clock as without one", async () => {
		const { session, info } = await opened(grid(600, 80, 'paperSize="8" scale="10"'))
		const asked = await request(session, info)
		const plain = await exportSheetPdf(asked, { session, assets: nodeFontAssets, deterministic: true })
		const sliced = await exportSheetPdf(asked, {
			session,
			assets: nodeFontAssets,
			deterministic: true,
			slicing: { sliceMs: 0, now: () => 0, pause: () => new Promise<void>(resolve => setTimeout(resolve, 0)) }
		})

		if (!plain.ok || !sliced.ok) throw new Error("not exported")

		expect(plain.pages).toBe(1)
		expect(pdfBytes(sliced.output.parts as never)).toEqual(pdfBytes(plain.output.parts as never))
		session.close()
	}, 120_000)
})
