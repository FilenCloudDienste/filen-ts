import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { format, resolveConfig } from "prettier"
import { describe, expect, it } from "vitest"
import { parseDataModel } from "../core/smartart/data"
import { newDiagramData } from "../core/smartart/edit"
import { emitDiagram } from "../core/smartart/emit"
import { generateGallery } from "../core/smartart/gallery/generate"
import { layoutDiagram } from "../core/smartart/interp"
import { parseLayoutDef, type Atom, type LayoutDefinition } from "../core/smartart/layoutDef"
import { encodeUtf8, parseXml, type XmlDocument } from "../core/xml/index"
import { measurer } from "./smartartFixtures"
import { budget, cpuMs } from "./timing"

// Our gallery's lists, processes, cycles and pyramids with their style and colour definitions: the generated
// modules match the definition files, every file says it is ours, every layout lays out any number of items with
// every text drawn (whichever layout of its category the data was made for, as "change layout" keeps the data),
// and every style and colour definition covers each style label the layouts use.

const PACKAGE = join(import.meta.dirname, "..", "..")
const ASSETS = join(PACKAGE, "assets", "smartart")
const GALLERY = join(PACKAGE, "src", "core", "smartart", "gallery")
const FAMILIES = ["list", "process", "cycle", "pyramid"] as const
const RELAYOUT_BUDGET_MS = 60
const BOX = { x: 0, y: 0, w: 8_000_000, h: 4_500_000 }
const AUTHORSHIP =
	/^<\?xml[^>]*\?>\n<!--\n\tFilen SmartArt gallery definition\. Written by Filen from the semantics of ECMA-376 Part 1 §21\.4 \(DrawingML\n\tdiagrams\); no Microsoft definition file was copied or used as a source\.\n\tnameKey: previewPptxSmartArt(?:Layout|Style|Colors)[A-Za-z0-9]+\n-->\n/u

interface Source {
	readonly file: string
	readonly xml: string
}

function sources(directory: string, prefix: string): Source[] {
	return readdirSync(directory)
		.filter(file => file.startsWith(`${prefix}-`) && file.endsWith(".xml"))
		.sort()
		.map(file => ({ file, xml: readFileSync(join(directory, file), "utf8") }))
}

// Each family's definition files, by the module name they generate.
function generatedFamilies(): [string, Source[]][] {
	return [
		...FAMILIES.map(family => [family, sources(ASSETS, family)] as [string, Source[]]),
		["styles", sources(join(ASSETS, "styles"), "styles")],
		["colors", sources(join(ASSETS, "colors"), "colors")]
	]
}

function idOf(xml: string): string {
	return /uniqueId="([^"]+)"/u.exec(xml)?.[1] ?? ""
}

function doc(xml: string): XmlDocument {
	return parseXml(encodeUtf8(xml))
}

const LAYOUTS = FAMILIES.flatMap(family =>
	sources(ASSETS, family).map(source => ({
		family,
		file: source.file,
		uniqueId: idOf(source.xml),
		def: parseLayoutDef(doc(source.xml))
	}))
)
const STYLES = sources(join(ASSETS, "styles"), "styles")
const COLORS = sources(join(ASSETS, "colors"), "colors")

// `count` items, every third a sub-item of the one before it.
function items(count: number): string[] {
	return Array.from({ length: count }, (_, i) => (i % 3 === 2 ? `\tSub ${String(i)}` : `Item ${String(i)}`))
}

function styleLabels(def: LayoutDefinition): Set<string> {
	const out = new Set<string>()
	const visit = (atoms: readonly Atom[]): void => {
		for (const atom of atoms) {
			if (atom.kind === "choose") {
				for (const branch of atom.branches) visit(branch.children)
				if (atom.otherwise !== undefined) visit(atom.otherwise.children)
				continue
			}

			if (atom.kind === "layoutNode" && atom.styleLbl !== undefined) out.add(atom.styleLbl)

			visit(atom.children)
		}
	}

	visit([def.root])

	return out
}

async function formatted(source: string, file: string): Promise<string> {
	const config = await resolveConfig(file)

	return format(source, { ...config, filepath: file })
}

describe("SmartArt gallery: lists, processes, cycles and pyramids", () => {
	it("keeps each family's generated modules equal to its definition files", async () => {
		for (const [family, files] of generatedFamilies()) {
			expect(files.length, family).toBeGreaterThan(0)

			const generated = generateGallery(family, files)

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

	it("holds twelve layouts, six styles and eight colour definitions, each starting with our authorship header", () => {
		expect(LAYOUTS.map(layout => layout.file)).toEqual([
			"list-basic.xml",
			"list-horizontal-bullet.xml",
			"list-stacked.xml",
			"list-vertical-bullet.xml",
			"process-accent.xml",
			"process-basic.xml",
			"process-continuous-arrow.xml",
			"process-step-down.xml",
			"cycle-basic.xml",
			"cycle-segmented.xml",
			"pyramid-basic.xml",
			"pyramid-inverted.xml"
		])
		expect(STYLES).toHaveLength(6)
		expect(COLORS).toHaveLength(8)

		for (const [, files] of generatedFamilies()) for (const { file, xml } of files) expect(xml, file).toMatch(AUTHORSHIP)
	})

	it("names every definition with a uniqueId no other definition file in the gallery uses", () => {
		const ours = new Set([...LAYOUTS.map(layout => layout.uniqueId), ...[...STYLES, ...COLORS].map(source => idOf(source.xml))])
		const others = [
			...readdirSync(ASSETS).filter(file => file.endsWith(".xml") && !FAMILIES.some(family => file.startsWith(`${family}-`)))
		].map(file => idOf(readFileSync(join(ASSETS, file), "utf8")))

		expect(ours.size).toBe(LAYOUTS.length + STYLES.length + COLORS.length)
		for (const id of others) expect(ours.has(id), id).toBe(false)
	})

	it("names every layout node, iteration and branch of a layout uniquely, as the schema's name attribute requires", () => {
		for (const { file, xml } of FAMILIES.flatMap(family => sources(ASSETS, family))) {
			const names = [...xml.matchAll(/<sa:(?:layoutNode|forEach|choose|if|else) name="([^"]+)"/gu)].map(match => match[1])

			expect(names.length, file).toBeGreaterThan(0)
			expect(new Set(names).size, file).toBe(names.length)
		}
	})

	it("lays every layout out with 1, 3, 8 and 30 items within the relayout budget, every text drawn", { timeout: budget(60_000) }, () => {
		const style = doc(STYLES[0]?.xml ?? "")
		const colors = doc(COLORS[0]?.xml ?? "")

		for (const layout of LAYOUTS) {
			for (const count of [1, 3, 8, 30]) {
				const texts = items(count)
				const data = doc(newDiagramData(texts, { layout: { uniqueId: layout.uniqueId } }))
				const start = cpuMs()
				const drawing = emitDiagram(layoutDiagram(parseDataModel(data), layout.def, style, colors, BOX, measurer)).drawingXml
				const ms = cpuMs() - start

				expect(ms, `${layout.file} ${String(count)}`).toBeLessThan(budget(RELAYOUT_BUDGET_MS))

				for (const text of texts) expect(drawing, `${layout.file} ${String(count)}`).toContain(text.trim())
			}
		}
	})

	it("keeps every text when the data of one layout is laid out with each other layout of its category", () => {
		const style = doc(STYLES[0]?.xml ?? "")
		const colors = doc(COLORS[0]?.xml ?? "")
		const texts = ["One", "\tOne a", "\tOne b", "Two", "Three", "\tThree a", "Four"]

		for (const from of LAYOUTS) {
			const data = parseDataModel(doc(newDiagramData(texts, { layout: { uniqueId: from.uniqueId, category: from.family } })))

			for (const to of LAYOUTS.filter(each => each.family === from.family && each !== from)) {
				const drawing = emitDiagram(layoutDiagram(data, to.def, style, colors, BOX, measurer)).drawingXml

				for (const text of texts) expect(drawing, `${from.file} → ${to.file}`).toContain(text.trim())
			}
		}
	})

	it("styles and colours every style label the layouts use, in every style and colour definition", () => {
		const used = new Set(LAYOUTS.flatMap(layout => [...styleLabels(layout.def)]))

		expect(used.size).toBeGreaterThan(0)

		for (const { file, xml } of [...STYLES, ...COLORS]) {
			for (const label of used) expect(xml, `${file} ${label}`).toContain(`<sa:styleLbl name="${label}">`)
		}
	})

	it("mirrors a row layout for a right-to-left diagram", () => {
		const layout = LAYOUTS.find(each => each.file === "process-basic.xml")

		if (layout === undefined) throw new Error("no basic process")

		const style = doc(STYLES[0]?.xml ?? "")
		const colors = doc(COLORS[0]?.xml ?? "")
		const firstX = (dir: string): number => {
			const data = newDiagramData(["First", "Second"], { layout: { uniqueId: layout.uniqueId } })
			const root = /<dgm:pt modelId="([^"]+)" type="doc">/u.exec(data)?.[1] ?? ""
			// The root layout node's presentation point carries the diagram's direction (§21.4.3.4 presLayoutVars).
			const xml = data.replace(
				"</dgm:ptLst>",
				`<dgm:pt modelId="9999" type="pres"><dgm:prSet presAssocID="${root}" presName="row" presStyleCnt="0"><dgm:presLayoutVars><dgm:dir val="${dir}"/></dgm:presLayoutVars></dgm:prSet><dgm:spPr/></dgm:pt></dgm:ptLst>`
			)
			const shapes = layoutDiagram(parseDataModel(doc(xml)), layout.def, style, colors, BOX, measurer).shapes
			const first = shapes.find(shape => shape.text.some(point => point.paragraphs.includes("First")))

			return first?.box.x ?? Number.NaN
		}

		expect(firstX("norm")).toBeLessThan(BOX.w / 2)
		expect(firstX("rev")).toBeGreaterThan(BOX.w / 2)
	})
})
