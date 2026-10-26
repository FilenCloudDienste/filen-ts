import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { describe, expect, it } from "vitest"
import { DrawingList, ItemFlag, ItemFloat, ItemInt, ItemKind } from "../core/drawingml/displayList"
import { D, drawingReader } from "../core/drawingml/reader"
import { drawingTheme } from "../core/drawingml/color"
import type { ShapeNode, TableModel } from "../core/presentation/model"
import { RenderReport } from "../core/presentation/render/effects"
import { cachedDrawing } from "../core/presentation/render/frame"
import { renderSlide } from "../core/presentation/render/slide"
import { renderTable } from "../core/presentation/render/table"
import type { Slicing } from "../core/slicing"
import { CORPUS_DIR } from "./corpusDir"
import { openRenderDeck } from "./fixtures/presentation/renderDeck"
import { extensionOf, readCorpusList } from "./oracles/presentation/corpus"

// The slide renderer over every OOXML deck of the frozen corpus: every slide renders (or refuses typed), presentation
// text never reaches the drawing as DrawingML text, and what was approximated is counted. With the LibreOffice table
// geometry (FILEN_OFFICE_LO_TABLES, from a UNO dump of column widths and row heights), every table's cell edges are
// compared with LibreOffice's.

const MANIFEST = join(import.meta.dirname, "../../corpus/manifest.json")
const OOXML = new Set(["pptx", "pptm", "potx", "potm", "ppsx", "ppsm"])
const SLICING: Slicing = { pause: () => Promise.resolve(), sliceMs: 1e9, now: () => 0 }
const LO_TABLES = process.env["FILEN_OFFICE_LO_TABLES"]
// 1 mm in px.
const MM = 96 / 25.4
// Roles whose drawing carries its own DrawingML text: charts, cached SmartArt drawings, and content kept as written.
const OWN_TEXT = new Set(["chart", "smartart"])

function files(): string[] {
	if (!existsSync(MANIFEST) || !existsSync(CORPUS_DIR)) return []

	return readCorpusList(MANIFEST)
		.map(entry => entry.path)
		.filter(path => OOXML.has(extensionOf(path)) && existsSync(join(CORPUS_DIR, path)))
}

const FILES = files()

function holdsChart(shape: ShapeNode): boolean {
	return shape.frame?.kind === "chart" || (shape.children ?? []).some(holdsChart)
}

function tables(shapes: readonly ShapeNode[]): ShapeNode[] {
	return shapes.flatMap(shape => (shape.frame?.kind === "table" ? [shape] : tables(shape.children ?? [])))
}

describe.skipIf(FILES.length === 0)("slide renderer over the corpus", () => {
	it(
		"renders every slide of every OOXML deck, with presentation text only as text pages",
		async () => {
			const report = new RenderReport()
			let slides = 0
			let decks = 0
			let bodyItems = 0
			const failures: string[] = []

			for (const path of FILES) {
				let opened: Awaited<ReturnType<typeof openRenderDeck>>

				try {
					opened = await openRenderDeck(readFileSync(join(CORPUS_DIR, path)))
				} catch {
					continue
				}

				if (opened === undefined) continue

				decks++

				for (const ref of opened.deck.slides) {
					try {
						const render = await renderSlide(opened.deck, ref, opened.services, SLICING, report)

						slides++

						for (const layer of render.layers) {
							// The layer's shape on the slide, its layout or its master.
							const slide = opened.deck.nodes.get(ref)
							const layout = slide?.parent === undefined ? undefined : opened.deck.nodes.get(slide.parent)
							const master = layout?.parent === undefined ? undefined : opened.deck.nodes.get(layout.parent)
							const level = layer.role === "master" ? master : layer.role === "layout" ? layout : slide
							const shape = level?.shapes.find(candidate => candidate.id === layer.shape.id)

							if (!OWN_TEXT.has(layer.role) && shape !== undefined && shape.kind !== "opaque" && !holdsChart(shape)) {
								const count = layer.drawing.texts.filter(text => text.kind === "body").length

								if (count > 0)
									failures.push(`${path} ${String(ref)}: ${String(count)} DrawingML text bodies in a ${layer.role} layer`)
								bodyItems += count
							}
						}
					} catch (error) {
						failures.push(`${path} ${String(ref)}: ${error instanceof Error ? error.message : String(error)}`)
					}
				}
			}

			writeFileSync(join(tmpdir(), "filen-office-render-corpus.json"), JSON.stringify({ decks, slides, failures, report }, null, 1))

			expect(failures).toEqual([])
			expect(bodyItems).toBe(0)
			expect(slides).toBeGreaterThan(1000)
		},
		20 * 60_000
	)

	it.skipIf(LO_TABLES === undefined || !existsSync(LO_TABLES))(
		"places every table's columns and rows within 1 mm of LibreOffice",
		async () => {
			const lo = JSON.parse(readFileSync(LO_TABLES ?? "", "utf8")) as Record<
				string,
				{ x: number; y: number; cols: number[]; rows: number[] }[][] | { error: string }
			>
			let compared = 0
			let matched = 0
			let rowsCompared = 0
			let rowsMatched = 0
			const misses: string[] = []

			for (const path of FILES) {
				const expected = lo[basename(path)]

				if (expected === undefined || !Array.isArray(expected)) continue

				const opened = await openRenderDeck(readFileSync(join(CORPUS_DIR, path)))

				if (opened === undefined) continue

				opened.deck.slides.forEach((ref, index) => {
					const shapes = tables(opened.deck.nodes.get(ref)?.shapes ?? [])
					const theirs = expected[index] ?? []

					shapes.forEach((shape, k) => {
						const want = theirs[k]
						const frame = shape.frame

						if (want === undefined || frame?.kind !== "table") return

						const ours = renderTable({
							table: frame.table as TableModel,
							context: {
								list: new DrawingList(),
								theme: drawingTheme(undefined, () => undefined),
								images: () => undefined,
								effects: false
							},
							services: opened.services,
							part: frame.table.src?.part,
							tableStyles: undefined,
							textHeight: () => 0
						})
						const columns = ours.columnEdges.slice(1).map((edge, c) => edge - (ours.columnEdges[c] ?? 0))
						const rows = ours.rowEdges.slice(1).map((edge, r) => edge - (ours.rowEdges[r] ?? 0))
						const columnsOk =
							columns.length === want.cols.length &&
							columns.every((width, c) => Math.abs(width - ((want.cols[c] ?? 0) / 100) * MM) <= MM)

						compared++
						rows.forEach((height, r) => {
							rowsCompared++

							if (Math.abs(height - ((want.rows[r] ?? 0) / 100) * MM) <= MM) rowsMatched++
						})

						if (columnsOk && rows.length === want.rows.length) matched++
						else misses.push(`${path} slide ${String(index + 1)} table ${String(k)}`)
					})
				})
			}

			writeFileSync(
				join(tmpdir(), "filen-office-render-tables.json"),
				JSON.stringify({ compared, matched, rowsCompared, rowsMatched, misses }, null, 1)
			)

			const total = FILES.map(path => lo[basename(path)]).reduce(
				(sum, slides) => sum + (Array.isArray(slides) ? slides.reduce((count, slide) => count + slide.length, 0) : 0),
				0
			)

			expect(compared).toBe(total)
			expect(misses).toEqual([])
			expect(rowsMatched).toBe(rowsCompared)
		},
		20 * 60_000
	)

	it(
		"renders every cached SmartArt drawing as the cache (each drawn shape within IoU 0.99 of its dsp box)",
		async () => {
			let shapes = 0
			let diagrams = 0
			const below: string[] = []

			for (const path of FILES) {
				const opened = await openRenderDeck(readFileSync(join(CORPUS_DIR, path)))

				if (opened === undefined) continue

				for (const ref of opened.deck.slides) {
					const slide = opened.deck.nodes.get(ref)
					const render = await renderSlide(opened.deck, ref, opened.services, SLICING)

					for (const layer of render.layers) {
						const frame = slide?.shapes.find(shape => shape.id === layer.shape.id)?.frame

						if (layer.role !== "smartart" || frame?.kind !== "smartart") continue

						const part = frame.drawing ?? cachedDrawing(opened.services, frame.data, slide?.part)
						const document = part === undefined ? undefined : opened.services.xml(part)

						if (document === undefined) continue

						diagrams++

						const reader = drawingReader(document)
						const data = layer.drawing

						for (let item = 0; item < data.itemCount; item++) {
							const ints = item * 10
							const floats = item * 10

							if ((data.itemInts[ints + ItemInt.FLAGS] ?? 0) & ItemFlag.DECORATION) continue
							if (data.itemInts[ints + ItemInt.KIND] === ItemKind.TEXT) continue

							const node = data.itemInts[ints + ItemInt.SOURCE] ?? -1
							const parent = document.parent(node)

							// Shapes of nested groups are placed through their group's child space.
							if (!reader.is(parent, D.Dsp, "spTree")) continue

							const xfrmNode = reader.child(reader.child(node, D.Dsp, "spPr"), D.A, "xfrm")
							const off = reader.child(xfrmNode, D.A, "off")
							const ext = reader.child(xfrmNode, D.A, "ext")
							const want = [
								reader.emu(off, "x", 0),
								reader.emu(off, "y", 0),
								reader.emu(ext, "cx", 0),
								reader.emu(ext, "cy", 0)
							].map(value => value / 9525)
							const f = (field: number): number => data.itemFloats[floats + field] ?? 0
							const w = f(ItemFloat.WIDTH)
							const h = f(ItemFloat.HEIGHT)
							const cx =
								f(ItemFloat.A) * (f(ItemFloat.X) + w / 2) + f(ItemFloat.C) * (f(ItemFloat.Y) + h / 2) + f(ItemFloat.E)
							const cy =
								f(ItemFloat.B) * (f(ItemFloat.X) + w / 2) + f(ItemFloat.D) * (f(ItemFloat.Y) + h / 2) + f(ItemFloat.F)
							const iou = boxIou([cx - w / 2, cy - h / 2, w, h], want)

							shapes++

							if (iou < 0.99) below.push(`${path} slide ${String(render.index + 1)}: ${iou.toFixed(3)}`)
						}
					}
				}
			}

			writeFileSync(join(tmpdir(), "filen-office-render-smartart.json"), JSON.stringify({ diagrams, shapes, below }, null, 1))

			expect(diagrams).toBeGreaterThan(0)
			expect(below).toEqual([])
		},
		20 * 60_000
	)
})

function boxIou(a: readonly number[], b: readonly number[]): number {
	const [ax = 0, ay = 0, aw = 0, ah = 0] = a
	const [bx = 0, by = 0, bw = 0, bh = 0] = b
	const ix = Math.max(0, Math.min(ax + aw, bx + bw) - Math.max(ax, bx))
	const iy = Math.max(0, Math.min(ay + ah, by + bh) - Math.max(ay, by))
	const intersection = ix * iy
	const union = aw * ah + bw * bh - intersection

	return union <= 0 ? (aw === bw && ah === bh ? 1 : 0) : intersection / union
}
