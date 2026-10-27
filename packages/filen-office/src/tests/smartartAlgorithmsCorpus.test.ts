import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { unzipSync, zipSync } from "fflate"
import { afterAll, describe, expect, it } from "vitest"
import { OpcPackage, bytesSource } from "@filen/office/core/opc"
import { D, drawingReader } from "../core/drawingml/reader"
import { themeOf } from "../core/presentation/theme"
import { smartArtFontRequests, textAdapterMeasurer } from "../core/smartart/measure"
import { AVERAGE_MEASURER, relayoutDiagram } from "../dom/presentation/engine/smartart"
import { CORPUS_DIR } from "./corpusDir"
import { loadAllowlist, newSdkErrors, OpenXmlSdk, openXmlSdkMissing, sdkErrorCounts } from "./oracles/openXmlSdk"
import { fontsFor, openDeck } from "./presentationTextHarness"
import { scoreFile, type DiagramScore, type MeasurerFor } from "./smartartIoU"

// Every corpus diagram that ships PowerPoint's own drawing, laid out by the whole engine (interpreter and every
// algorithm) from the file's data and embedded layout definition and scored per shape by IoU against the cached
// box (smartartIoU.ts); and the drawings the engine emits, put in place of the cached ones, through the Open XML
// SDK (FILEN_OFFICE_OOXML_VALIDATOR; skipped without it).

const fetched = existsSync(CORPUS_DIR)
const FAMILIES = ["pptx", "potx", "pptm", "ppsx", "ppsm", "potm"]
const DIAGRAM_DRAWING = "http://schemas.microsoft.com/office/2007/relationships/diagramDrawing"

function median(values: readonly number[]): number {
	const sorted = [...values].sort((a, b) => a - b)
	const mid = sorted.length >> 1

	return sorted.length === 0
		? 0
		: sorted.length % 2 === 1
			? (sorted[mid] as number)
			: ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2
}

function corpusFiles(): string[] {
	if (!fetched) return []

	const out: string[] = []

	for (const family of FAMILIES) {
		const dir = join(CORPUS_DIR, family)

		if (!existsSync(dir)) continue

		for (const name of readdirSync(dir).sort()) {
			const bytes = readFileSync(join(dir, name))

			if (bytes[0] === 0x50 && bytes[1] === 0x4b && bytes.includes(Buffer.from("ppt/diagrams/"))) out.push(`${family}/${name}`)
		}
	}

	return out
}

const FILES = corpusFiles()

async function measurers(path: string): Promise<MeasurerFor | undefined> {
	const opened = await openDeck(path).catch(() => undefined)

	if (opened === undefined) return undefined

	return async (slide, texts) => {
		const deck = opened.deck
		const node = [...deck.nodes.values()].find(n => n.part === `/${slide}` || n.part === slide)

		if (node === undefined) throw new Error(`${path}: no slide ${slide}`)

		const theme = themeOf(deck.nodes, node)
		const fonts = fontsFor(deck, node, theme === undefined ? undefined : opened.theme(theme.part))

		await opened.fonts.prepare(smartArtFontRequests(texts, fonts))

		return textAdapterMeasurer(opened.environment, fonts)
	}
}

// The layouts whose every corpus diagram the engine reproduces (mean IoU of their cached shapes).
const EXACT = [
	"default",
	"vProcess5",
	"chevron1",
	"vList5",
	"venn1",
	"venn2",
	"venn3",
	"radial4",
	"pList2",
	"matrix1",
	"pyramid1",
	"hProcess6"
]

describe.skipIf(FILES.length === 0)("SmartArt layout against PowerPoint's cached drawings", () => {
	it("reproduces the cached boxes of the corpus diagrams", { timeout: 300_000 }, async () => {
		const scores: DiagramScore[] = []

		for (const file of FILES)
			scores.push(...(await scoreFile(join(CORPUS_DIR, file), file, undefined, await measurers(join(CORPUS_DIR, file)))))

		const shapes = scores.flatMap(score => score.shapes.map(shape => shape.iou))

		expect(scores.every(score => score.error === undefined)).toBe(true)
		expect(scores.length).toBeGreaterThanOrEqual(48)
		expect(median(scores.map(score => score.mean))).toBeGreaterThanOrEqual(0.99)
		expect(median(shapes)).toBeGreaterThanOrEqual(0.88)

		for (const score of scores.filter(s => EXACT.includes(s.layout)))
			expect(score.mean, `${score.file} ${score.layout}`).toBeGreaterThanOrEqual(0.99)

		// Connectors routed between their nodes after the user's offsets moved them.
		for (const score of scores.filter(s => s.layout === "bProcess3")) {
			for (const shape of score.shapes.filter(s => s.name === "sibTrans")) expect(shape.iou, score.file).toBeGreaterThanOrEqual(0.85)
		}
	})
})

const sdkMissing = openXmlSdkMissing()
const dir = mkdtempSync(join(tmpdir(), "smartart-emit-"))

afterAll(() => {
	rmSync(dir, { recursive: true, force: true })
})

// The package with each cached diagram drawing replaced by the one the engine emits; undefined without one.
async function withEmittedDrawings(file: string): Promise<Uint8Array | undefined> {
	const path = join(CORPUS_DIR, file)
	const bytes = new Uint8Array(readFileSync(path))
	const pkg = await OpcPackage.open(bytesSource(bytes))
	const replaced = new Map<string, Uint8Array>()

	for (const slide of [...pkg.entries()].map(e => e.name).filter(name => /^ppt\/slides\/slide\d+\.xml$/u.test(name))) {
		const document = await pkg.xml(slide)
		const reader = drawingReader(document)
		const rels = await pkg.relationships(slide)

		for (let node = 0; node < document.count; node++) {
			if (!reader.is(node, D.Dgm, "relIds")) continue

			let frame = node

			while (frame >= 0 && document.localName(frame) !== "graphicFrame") frame = document.parent(frame)

			const ext = reader.child(reader.child(frame, reader.group(frame), "xfrm"), D.A, "ext")
			const part = (attr: string): string | undefined => rels.byId(reader.attrNs(node, D.R, attr) ?? "")?.partName
			const [dm, lo, qs, cs] = [part("dm"), part("lo"), part("qs"), part("cs")]

			if (dm === undefined || lo === undefined || ext < 0) continue

			const data = await pkg.xml(dm)
			const relId =
				drawingReader(data).attr(drawingReader(data).descendant(data.documentElement(), D.Dsp, "dataModelExt"), "relId") ?? ""
			const drawing = ((await pkg.relationships(dm)).byId(relId) ?? rels.byId(relId) ?? rels.byType(DIAGRAM_DRAWING)[0])?.partName

			if (drawing === undefined || !pkg.has(drawing)) continue

			const emitted = relayoutDiagram(
				{
					data,
					layout: await pkg.xml(lo),
					style: qs === undefined || !pkg.has(qs) ? undefined : await pkg.xml(qs),
					colors: cs === undefined || !pkg.has(cs) ? undefined : await pkg.xml(cs)
				},
				{ w: reader.emu(ext, "cx", 0), h: reader.emu(ext, "cy", 0) },
				// Validity does not depend on the sizes text settles on.
				() => AVERAGE_MEASURER
			)

			replaced.set(drawing, new TextEncoder().encode(emitted.drawingXml))
		}
	}

	if (replaced.size === 0) return undefined

	const entries = unzipSync(bytes)

	for (const [name, content] of replaced) entries[name] = new Uint8Array(content)

	return zipSync(entries)
}

describe.skipIf(FILES.length === 0 || sdkMissing !== undefined)("SmartArt drawings the engine emits, through the Open XML SDK", () => {
	it("adds no validation error to any corpus deck", { timeout: 600_000 }, async () => {
		const sdk = new OpenXmlSdk()
		const allow = loadAllowlist()
		const failures: string[] = []
		let checked = 0

		try {
			for (const file of FILES) {
				const rewritten = await withEmittedDrawings(file)

				if (rewritten === undefined) continue

				const out = join(dir, file.replace(/\//gu, "_"))

				writeFileSync(out, rewritten)

				const before = sdkErrorCounts(await sdk.validate(join(CORPUS_DIR, file)))
				const after = sdkErrorCounts(await sdk.validate(out))

				for (const error of newSdkErrors(before, after, allow)) failures.push(`${file}: ${error}`)

				checked++
			}
		} finally {
			await sdk.close()
		}

		expect(failures).toEqual([])
		expect(checked).toBeGreaterThan(0)
	})
})
