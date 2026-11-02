import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { strToU8, unzipSync, zipSync } from "fflate"
import type { ShapeNode, SlideNode, SlideRef } from "../core/presentation/model"
import { pptxParts } from "../dom/presentation/engine/open/pptx"
import { review } from "../dom/presentation/engine/review"
import { smartArtRenderer } from "../dom/presentation/engine/smartart"
import { CORPUS_DIR } from "./corpusDir"
import { driveSession } from "./odpWriteDrive"
import { danglingReferences, partsOf } from "./pptxWriteFixtures"

// Diagram parts more than one frame names (a duplicated slide's copy, a file whose slides share them): an edit of one
// frame writes its own parts and leaves the others' as they were.

const STRIP = join(CORPUS_DIR, "pptx", "lo__smartart-picture-strip.pptx")
const PIE = join(CORPUS_DIR, "pptx", "lo__tdf149551_SmartArt_Pie.pptx")

// The Pie deck with a second slide relating the first's diagram parts (data, layout, style, colours and drawing).
function sharedPie(path: string = PIE): Uint8Array {
	const files = unzipSync(new Uint8Array(readFileSync(path)))
	const text = (name: string): string => new TextDecoder().decode(files[name])

	files["ppt/slides/slide2.xml"] = files["ppt/slides/slide1.xml"] ?? new Uint8Array(0)
	files["ppt/slides/_rels/slide2.xml.rels"] = files["ppt/slides/_rels/slide1.xml.rels"] ?? new Uint8Array(0)
	files["ppt/_rels/presentation.xml.rels"] = strToU8(
		text("ppt/_rels/presentation.xml.rels").replace(
			"</Relationships>",
			'<Relationship Id="rId900" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide2.xml"/></Relationships>'
		)
	)
	files["ppt/presentation.xml"] = strToU8(
		text("ppt/presentation.xml").replace(/(<p:sldId [^>]*\/>)(<\/p:sldIdLst>)/u, '$1<p:sldId id="9999" r:id="rId900"/>$2')
	)
	files["[Content_Types].xml"] = strToU8(
		text("[Content_Types].xml").replace(
			"</Types>",
			'<Override PartName="/ppt/slides/slide2.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/></Types>'
		)
	)

	return zipSync(files)
}

async function differing(a: Uint8Array, b: Uint8Array): Promise<string[]> {
	const left = await partsOf(a)
	const right = await partsOf(b)
	const same = (x: Uint8Array | undefined, y: Uint8Array | undefined): boolean =>
		x !== undefined && y !== undefined && x.length === y.length && x.every((byte, at) => byte === y[at])

	return [...new Set([...left.keys(), ...right.keys()])].filter(name => !same(left.get(name), right.get(name))).sort()
}

// As `differing`, with each slide's diagram relationships read by what they name: an edit of a diagram the file shares
// between slides writes parts of its own under new relationship ids, and an undo relates the file's parts again under
// ids of the slide's (the drawing's keeps the id its data names) in an a:graphic written anew.
async function differingParts(a: Uint8Array, b: Uint8Array): Promise<string[]> {
	const read = async (bytes: Uint8Array): Promise<Map<string, string>> => {
		const parts = await partsOf(bytes)
		const text = (name: string): string => new TextDecoder().decode(parts.get(name))
		const out = new Map<string, string>()

		for (const name of parts.keys()) {
			const slide = /^ppt\/slides\/(?:_rels\/)?(slide\d+)\.xml(?:\.rels)?$/u.exec(name)?.[1]

			if (slide === undefined) {
				out.set(name, text(name))

				continue
			}

			const rels = text(`ppt/slides/_rels/${slide}.xml.rels`)
			const all = [...rels.matchAll(/<Relationship [^>]*\/>/gu)].map(match => match[0])
			const target = (id: string): string => /Target="([^"]+)"/u.exec(all.find(each => each.includes(`Id="${id}"`)) ?? "")?.[1] ?? id

			out.set(
				name,
				name.endsWith(".rels")
					? all
							.map(each => (each.includes("/diagramDrawing") ? each : each.replace(/ Id="[^"]+"/u, "")))
							.sort()
							.join("")
					: text(name)
							.replace(/>\s+</gu, "><")
							.replace(/r:(dm|lo|qs|cs)="([^"]+)"/gu, (_, kind: string, id: string) => `r:${kind}="${target(id)}"`)
			)
		}

		return out
	}
	const left = await read(a)
	const right = await read(b)

	return [...new Set([...left.keys(), ...right.keys()])].filter(name => left.get(name) !== right.get(name)).sort()
}

// Each slide's diagrams by what their parts hold: every r:dm/lo/qs/cs part's text, and the drawing its data names
// (a file's shared diagram an edit split comes back by content under the parts that undo writes it into).
async function diagramContents(bytes: Uint8Array): Promise<string[]> {
	const parts = await partsOf(bytes)
	const text = (name: string): string => new TextDecoder().decode(parts.get(name))
	const out: string[] = []

	for (const name of [...parts.keys()].sort()) {
		const slide = /^ppt\/slides\/(slide\d+)\.xml$/u.exec(name)?.[1]

		if (slide === undefined) continue

		const targets = new Map(
			[...text(`ppt/slides/_rels/${slide}.xml.rels`).matchAll(/<Relationship [^>]*\/>/gu)].map(
				([each]) => [/ Id="([^"]+)"/u.exec(each)?.[1], /Target="\.\.\/([^"]+)"/u.exec(each)?.[1]] as const
			)
		)
		const part = (id: string): string => `ppt/${targets.get(id) ?? "?"}`

		for (const match of text(name).matchAll(/r:(dm|lo|qs|cs)="([^"]+)"/gu)) {
			const data = part(match[2] ?? "")

			out.push(`${slide} ${match[1] ?? ""} ${parts.has(data) ? text(data) : "missing"}`)

			const relId = match[1] === "dm" ? /(?<![:\w])relId="([^"]+)"/u.exec(text(data))?.[1] : undefined

			if (relId !== undefined) out.push(`${slide} drawing ${parts.has(part(relId)) ? text(part(relId)) : "missing"}`)
		}
	}

	return out
}

function frameIn(shapes: readonly ShapeNode[]): ShapeNode | undefined {
	for (const shape of shapes) {
		if (shape.frame?.kind === "smartart") return shape

		const child = shape.children === undefined ? undefined : frameIn(shape.children)

		if (child !== undefined) return child
	}

	return undefined
}

async function opened(bytes: Uint8Array) {
	const d = await driveSession(bytes, "pptx")

	smartArtRenderer(d.session, {
		services: {
			xml: part => pptxParts(d.session.deck)?.document(part),
			relationship: () => undefined,
			contentType: () => undefined
		}
	})

	for (const slide of d.session.deck.slides) {
		await review(d.context, slide)

		const frame = frameIn((d.session.deck.nodes.get(slide) as SlideNode).shapes)

		if (frame !== undefined) return { d, slide, frame }
	}

	throw new Error("no diagram")
}

async function written(d: Awaited<ReturnType<typeof driveSession>>): Promise<Uint8Array> {
	const saved = await d.save()

	expect(saved.result).toEqual(expect.objectContaining({ kind: "written" }))

	if (saved.bytes === undefined) throw new Error("not saved")

	expect(await danglingReferences(saved.bytes)).toEqual([])

	return saved.bytes
}

describe.skipIf(!existsSync(STRIP))("a file diagram with pictures of its own, its slide duplicated", () => {
	for (const save of [false, true])
		it(`edited${save ? " and saved" : ""}, moved, then its slide duplicated: written`, async () => {
			const { d, slide, frame } = await opened(new Uint8Array(readFileSync(STRIP)))
			const target = { slide: slide as SlideRef, id: frame.id }

			expect(
				(
					await d.command({
						family: "smartart",
						kind: "setLayout",
						target,
						def: {
							uniqueId: "urn:filen:smartart:layout:picture-grid",
							source: "gallery"
						}
					})
				).ok
			).toBe(true)

			if (save) await written(d)

			const box = frame.xfrm ?? {
				x: 0,
				y: 0,
				cx: 1,
				cy: 1,
				rot: 0,
				flipH: false,
				flipV: false
			}

			expect(
				(
					await d.command({
						family: "shape",
						kind: "setXfrm",
						target,
						xfrm: { ...box, x: box.x + 12_700 }
					})
				).ok
			).toBe(true)
			expect((await d.command({ family: "slide", kind: "duplicate", slide })).ok).toBe(true)
			await written(d)
		})
})

describe.skipIf(!existsSync(PIE))("two slides relating the same diagram parts", () => {
	for (const kind of ["setLayout", "setStyle", "setColors"] as const)
		it(`${kind} on one writes its own parts, the other's stay as they were, and an undo after the save names the file's again`, async () => {
			const source = sharedPie()
			const { d, slide, frame } = await opened(source)
			const def =
				kind === "setLayout"
					? "urn:filen:smartart:layout:process-basic"
					: kind === "setStyle"
						? "urn:filen:smartart:style:moderate"
						: "urn:filen:smartart:colors:colorful"

			expect(d.session.deck.slides).toHaveLength(2)
			await review(d.context, d.session.deck.slides[1] as SlideRef)
			expect(
				(
					await d.command({
						family: "smartart",
						kind,
						target: { slide, id: frame.id },
						def: { uniqueId: def, source: "gallery" }
					})
				).ok
			).toBe(true)
			expect((await differing(source, await written(d))).filter(name => /^ppt\/diagrams\/[a-z]+1\.xml$/iu.test(name))).toEqual([])
			expect((await d.undo()).ok).toBe(true)
			expect(await differingParts(source, await written(d))).toEqual([])
		})
})

describe.skipIf(!existsSync(PIE))("an edited diagram's slide duplicated and its original deleted", () => {
	it("undone to before the save without saving between: the slides restored relate every drawing their data names", async () => {
		const { d, slide, frame } = await opened(new Uint8Array(readFileSync(PIE)))
		const def = { uniqueId: "urn:filen:smartart:layout:venn", source: "gallery" } as const

		expect((await d.command({ family: "slide", kind: "duplicate", slide })).ok).toBe(true)
		expect((await d.command({ family: "smartart", kind: "setLayout", target: { slide, id: frame.id }, def })).ok).toBe(true)
		expect((await d.command({ family: "slide", kind: "delete", slides: [d.session.deck.slides[1] as SlideRef] })).ok).toBe(true)
		expect((await d.command({ family: "slide", kind: "duplicate", slide })).ok).toBe(true)
		expect((await d.command({ family: "slide", kind: "delete", slides: [slide] })).ok).toBe(true)
		await written(d)

		// The slides come back (the rest of the chain, the diagram edit included: smartartRestoredUndo.test.ts).
		for (let step = 0; step < 3; step++) expect((await d.undo()).ok, `undo ${String(step + 1)}`).toBe(true)

		await written(d)
	})
})

// Parts of the session's diagrams no slide uses (related but named by no frame's r:dm/lo/qs/cs nor by their data's
// drawing relationship).
async function unusedDiagramParts(bytes: Uint8Array): Promise<string[]> {
	const parts = await partsOf(bytes)
	const text = (name: string): string => new TextDecoder().decode(parts.get(name))
	const used = new Set<string>()

	for (const name of parts.keys()) {
		const slide = /^ppt\/slides\/slide(\d+)\.xml$/u.exec(name)?.[1]

		if (slide === undefined) continue

		const rels = text(`ppt/slides/_rels/slide${slide}.xml.rels`)
		const target = (id: string): string | undefined =>
			new RegExp(`Id="${id}"[^>]*Target="\\.\\./diagrams/([^"]+)"`, "u").exec(rels)?.[1]

		for (const match of text(name).matchAll(/r:(dm|lo|qs|cs)="([^"]+)"/gu)) {
			const part = target(match[2] ?? "")

			if (part === undefined) continue

			used.add(part)

			if (match[1] !== "dm") continue

			const drawing = /(?<![:\w])relId="([^"]+)"/u.exec(text(`ppt/diagrams/${part}`))?.[1]
			const drawn = drawing === undefined ? undefined : target(drawing)

			if (drawn !== undefined) used.add(drawn)
		}
	}

	return [...parts.keys()].filter(name => /^ppt\/diagrams\/[^/]+$/u.test(name) && !used.has(name.split("/").pop() ?? ""))
}

const DIAGRAM_DECKS = ["lo__tdf149551_SmartArt_Pie.pptx", "lo__smartart-org-chart.pptx", "lo__smartart-picture-strip.pptx"].map(file =>
	join(CORPUS_DIR, "pptx", file)
)
const EDITS = [
	[0, "setLayout", "layout:process-basic"],
	[1, "setColors", "colors:colorful"],
	[0, "setStyle", "style:intense"]
] as const

for (const path of DIAGRAM_DECKS)
	describe.skipIf(!existsSync(path))(`two slides relating one diagram of ${path.split("/").pop() ?? ""}, both edited`, () => {
		async function edited(): Promise<{ d: Awaited<ReturnType<typeof driveSession>>; source: Uint8Array; states: Uint8Array[] }> {
			const source = sharedPie(path)
			const { d } = await opened(source)
			const slides = d.session.deck.slides as SlideRef[]
			const states: Uint8Array[] = [source]

			for (const slide of slides) await review(d.context, slide)

			for (const [at, kind, id] of EDITS) {
				const slide = slides[at] as SlideRef
				const frame = frameIn((d.session.deck.nodes.get(slide) as SlideNode).shapes) as ShapeNode

				expect(
					(
						await d.command({
							family: "smartart",
							kind,
							target: { slide, id: frame.id },
							def: { uniqueId: `urn:filen:smartart:${id}`, source: "gallery" }
						})
					).ok
				).toBe(true)
				states.push(await written(d))
			}

			return { d, source, states }
		}

		it("edited with one save, then undone to the start and saved: each slide's diagram again, its drawing related", async () => {
			const source = sharedPie(path)
			const { d } = await opened(source)
			const slides = d.session.deck.slides as SlideRef[]

			for (const slide of slides) await review(d.context, slide)

			for (const [at, kind, id] of EDITS) {
				const slide = slides[at] as SlideRef
				const frame = frameIn((d.session.deck.nodes.get(slide) as SlideNode).shapes) as ShapeNode

				expect(
					(
						await d.command({
							family: "smartart",
							kind,
							target: { slide, id: frame.id },
							def: { uniqueId: `urn:filen:smartart:${id}`, source: "gallery" }
						})
					).ok
				).toBe(true)
			}

			await written(d)

			for (let step = 0; step < EDITS.length; step++) expect((await d.undo()).ok).toBe(true)

			const back = await written(d)

			expect(await diagramContents(back)).toEqual(await diagramContents(source))
			expect(await unusedDiagramParts(back)).toEqual([])
		})

		it("undone one step at a time with a save after each: every saved state's parts again", async () => {
			const { d, states } = await edited()

			for (let at = states.length - 2; at >= 0; at--) {
				expect((await d.undo()).ok).toBe(true)
				expect(await differingParts(states[at] ?? new Uint8Array(0), await written(d))).toEqual([])
			}
		})

		for (const undone of [1, 2])
			it(`${String(undone)} undone and saved, then the history let go: no diagram part is left that nothing uses`, async () => {
				const { d } = await edited()
				const first = d.session.deck.slides[0] as SlideRef

				for (let step = 0; step < undone; step++) expect((await d.undo()).ok).toBe(true)

				await written(d)

				for (let at = 0; at <= 500; at++) await d.command({ family: "slide", kind: "hide", slides: [first], hidden: at % 2 === 0 })

				expect(await unusedDiagramParts(await written(d))).toEqual([])
			})
	})
