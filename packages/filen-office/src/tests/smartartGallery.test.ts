import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { format, resolveConfig } from "prettier"
import { describe, expect, it } from "vitest"
import { D, drawingReader } from "../core/drawingml/reader"
import { parseDataModel } from "../core/smartart/data"
import { newDiagramData } from "../core/smartart/edit"
import { emitDiagram } from "../core/smartart/emit"
import { generateGallery, minifyDefinition } from "../core/smartart/gallery/generate"
import { smartArtColorsDef, smartArtLayoutDef, smartArtStyleDef } from "../core/smartart/gallery/defs"
import { SMARTART_COLORS, SMARTART_LAYOUTS, SMARTART_STYLES } from "../core/smartart/gallery/index"
import { layoutDiagram } from "../core/smartart/interp"
import { parseLayoutDef } from "../core/smartart/layoutDef"
import { encodeUtf8, parseXml } from "../core/xml/index"
import { measurer } from "./smartartFixtures"
import { cpuMs } from "./timing"

// Our SmartArt gallery: the generated modules match the definition files they come from (and are written from them
// with FILEN_SMARTART_GALLERY_WRITE=1), every file carries its authorship header, and every layout of the registry
// lays out 1, 3, 8 and 30 nodes inside the relayout budget.

const PACKAGE = join(import.meta.dirname, "..", "..")
const ASSETS = join(PACKAGE, "assets", "smartart")
const GALLERY = join(PACKAGE, "src", "core", "smartart", "gallery")
const RELAYOUT_BUDGET_MS = 60

// Asset files by family (the file name up to its first "-").
function families(): Map<string, { file: string; xml: string }[]> {
	const out = new Map<string, { file: string; xml: string }[]>()

	for (const file of readdirSync(ASSETS).sort()) {
		if (!file.endsWith(".xml")) continue

		const family = file.slice(0, file.indexOf("-"))
		const list = out.get(family) ?? []

		list.push({ file, xml: readFileSync(join(ASSETS, file), "utf8") })
		out.set(family, list)
	}

	return out
}

async function formatted(source: string, file: string): Promise<string> {
	const config = await resolveConfig(file)

	return format(source, { ...config, filepath: file })
}

describe("SmartArt gallery generation", () => {
	it("keeps each family's generated modules equal to its definition files", async () => {
		for (const [family, sources] of families()) {
			const generated = generateGallery(family, sources)

			for (const [name, source] of [
				[`${family}.ts`, generated.names],
				[`${family}Defs.ts`, generated.defs]
			] as const) {
				const path = join(GALLERY, name)
				const text = await formatted(source, path)

				if (process.env["FILEN_SMARTART_GALLERY_WRITE"] === "1") writeFileSync(path, text)

				expect(existsSync(path), name).toBe(true)
				expect(readFileSync(path, "utf8"), name).toBe(text)
			}
		}
	})

	it("refuses a definition without the authorship header or with a uniqueId used twice", () => {
		const layout =
			'<dgm:layoutDef xmlns:dgm="http://schemas.openxmlformats.org/drawingml/2006/diagram" uniqueId="u"><dgm:catLst><dgm:cat type="list"/></dgm:catLst></dgm:layoutDef>'
		const header = "<!-- Filen SmartArt gallery definition. nameKey: previewX -->"

		expect(() => generateGallery("x", [{ file: "x-a.xml", xml: layout }])).toThrow(/authorship/u)
		expect(() => generateGallery("x", [{ file: "x-a.xml", xml: "<!-- Filen SmartArt gallery definition -->" + layout }])).toThrow(
			/nameKey/u
		)
		expect(() =>
			generateGallery("x", [
				{ file: "x-a.xml", xml: header + layout },
				{ file: "x-b.xml", xml: header + layout }
			])
		).toThrow(/twice/u)
		expect(generateGallery("x", [{ file: "x-a.xml", xml: header + layout }]).names).toContain('nameKey: "previewX"')
	})

	it("refuses a sample data model id that is not an ST_ModelId (an int or a GUID)", () => {
		const header = "<!-- Filen SmartArt gallery definition. nameKey: previewX -->"
		const layout = (id: string): string =>
			`<dgm:layoutDef xmlns:dgm="http://schemas.openxmlformats.org/drawingml/2006/diagram" uniqueId="u"><dgm:catLst><dgm:cat type="list"/></dgm:catLst><dgm:sampData><dgm:dataModel><dgm:ptLst><dgm:pt modelId="${id}" type="doc"/></dgm:ptLst></dgm:dataModel></dgm:sampData></dgm:layoutDef>`

		expect(() => generateGallery("x", [{ file: "x-a.xml", xml: header + layout("s0") }])).toThrow(/ST_ModelId/u)
		expect(() => generateGallery("x", [{ file: "x-a.xml", xml: header + layout("2147483648") }])).toThrow(/ST_ModelId/u)
		expect(() => generateGallery("x", [{ file: "x-a.xml", xml: header + layout("0") }])).not.toThrow()
		expect(() =>
			generateGallery("x", [{ file: "x-a.xml", xml: header + layout("{0A1B2C3D-0000-4000-8000-00000000000F}") }])
		).not.toThrow()
	})

	it("minifies a definition without touching text", () => {
		expect(minifyDefinition('<?xml version="1.0"?>\n<!-- c -->\n<a>\n\t<b> x </b>\n</a>\n')).toBe("<a>\n<b> x </b>\n</a>")
	})

	it("registers every definition with its text, each written by us", () => {
		expect(SMARTART_LAYOUTS.length).toBeGreaterThanOrEqual(2)
		expect(SMARTART_STYLES.length).toBeGreaterThanOrEqual(1)
		expect(SMARTART_COLORS.length).toBeGreaterThanOrEqual(1)

		// The root element by namespace and name: a definition may bind the diagram namespace to any prefix.
		const root = (text: string | undefined): string | undefined => {
			if (text === undefined) return undefined

			const document = parseXml(encodeUtf8(text))
			const element = document.documentElement()

			return drawingReader(document).group(element) === D.Dgm ? document.localName(element) : undefined
		}

		for (const entry of SMARTART_LAYOUTS) expect(root(smartArtLayoutDef(entry.uniqueId)), entry.uniqueId).toBe("layoutDef")
		for (const entry of SMARTART_STYLES) expect(root(smartArtStyleDef(entry.uniqueId)), entry.uniqueId).toBe("styleDef")
		for (const entry of SMARTART_COLORS) expect(root(smartArtColorsDef(entry.uniqueId)), entry.uniqueId).toBe("colorsDef")
	})

	it("lays every registry layout out with 1, 3, 8 and 30 nodes within the relayout budget, every text drawn", { timeout: 60_000 }, () => {
		const style = parseXml(encodeUtf8(smartArtStyleDef(SMARTART_STYLES[0]?.uniqueId ?? "") ?? ""))
		const colors = parseXml(encodeUtf8(smartArtColorsDef(SMARTART_COLORS[0]?.uniqueId ?? "") ?? ""))

		for (const entry of SMARTART_LAYOUTS) {
			const def = parseLayoutDef(parseXml(encodeUtf8(smartArtLayoutDef(entry.uniqueId) ?? "")))

			for (const count of [1, 3, 8, 30]) {
				const texts = Array.from({ length: count }, (_, i) => (i % 3 === 2 ? `\tSub ${String(i)}` : `Item ${String(i)}`))
				const data = parseXml(encodeUtf8(newDiagramData(texts, { layout: { uniqueId: entry.uniqueId } })))
				const start = cpuMs()
				const layout = layoutDiagram(parseDataModel(data), def, style, colors, { x: 0, y: 0, w: 8_000_000, h: 4_500_000 }, measurer)
				const drawing = emitDiagram(layout).drawingXml
				const ms = cpuMs() - start

				expect(ms, `${entry.uniqueId} ${String(count)}`).toBeLessThan(RELAYOUT_BUDGET_MS)

				for (const text of texts) expect(drawing, `${entry.uniqueId} ${String(count)}`).toContain(text.trim())
			}
		}
	})
})
