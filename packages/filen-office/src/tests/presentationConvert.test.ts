import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { bytesSource, memorySink, ZipArchive } from "@filen/office/core/opc"
import {
	canConvertPresentation,
	convertPresentation,
	ConversionReport,
	noteFresh,
	type ConversionSource,
	type PresentationTarget
} from "../core/convert/presentation/index"
import { fieldGuid } from "../core/convert/presentation/fromOdp"
import { openOdp } from "../core/odp/read/document"
import { pptToPptx } from "../core/ppt/toPptx"
import { openPptx, openPptxPackage } from "../core/pptx/package"
import type { Deck, ShapeNode } from "../core/presentation/model"
import { decryptionOf } from "../dom/encryption/legacyDecryption"
import { CORPUS_DIR } from "./corpusDir"
import { entriesOf, odpDeck, text } from "./odpWriteFixtures"
import { odpBytes, plainText, page } from "./odpFixtures"
import { modifyVerifierPptx } from "./fixtures/presentation/protected"
import { buildPpt, FIXTURE_PNG } from "./pptFixtures"
import { body, buildPptx, para, sp, xfrm } from "./pptxFixtures"
import { budget } from "./timing"

// Conversions between presentation formats through the fresh writers: what each target holds, what it holds
// differently (the report by kind), and the protected and gated cases. Over the corpus (when present): every ODP deck
// to .pptx and every PowerPoint 97–2003 deck to .odp, each reopening with its slide count and its slides' text.

type Opened = { readonly deck: Deck; readonly input: ConversionSource }

async function odp(bytes: Uint8Array): Promise<Opened> {
	const open = await openOdp(bytesSource(bytes))

	if (open.kind !== "opened") throw new Error(`${open.reason} ${open.detail ?? ""}`)

	return { deck: open.deck, input: { format: "odp", parts: open.parts } }
}

async function pptx(bytes: Uint8Array): Promise<Opened> {
	const open = await openPptx(bytesSource(bytes))

	if (open.kind !== "opened") throw new Error(`${open.reason} ${open.detail ?? ""}`)

	return {
		deck: open.deck,
		input: {
			format: "pptx",
			parts: open.parts,
			source: { archive: await ZipArchive.open(bytesSource(bytes)), package: open.parts.opc }
		}
	}
}

async function ppt(bytes: Uint8Array, password?: string): Promise<Opened> {
	const converted = await pptToPptx(bytesSource(bytes), password === undefined ? {} : { decryption: decryptionOf(password) })

	if (converted.kind !== "converted") throw new Error(converted.reason)

	const open = await openPptxPackage(converted.pptx, converted.encrypted ? { encrypted: { scheme: "rc4CryptoApi" } } : {})

	if (open.kind !== "opened") throw new Error(open.reason)

	open.deck.format = "ppt"

	return { deck: open.deck, input: { format: "ppt", parts: open.parts, pptx: converted.pptx, losses: () => converted.losses } }
}

async function convert(opened: Opened, target: PresentationTarget, seal?: (zip: Uint8Array) => Promise<Uint8Array>) {
	const sink = memorySink()
	const converted = await convertPresentation(opened.deck, opened.input, target, sink, seal === undefined ? {} : { seal })

	if ("kind" in converted) throw new Error(`${converted.reason} ${converted.detail ?? ""}`)

	return { bytes: sink.bytes(), losses: converted.losses, size: converted.bytes }
}

function shapeTexts(shapes: readonly ShapeNode[], out: string[] = []): string[] {
	for (const shape of shapes) {
		const own = plainText(shape).replace(/\s+/gu, " ").trim()

		if (own !== "") out.push(own)
		if (shape.children !== undefined) shapeTexts(shape.children, out)
	}

	return out
}

async function slideTexts(opened: Opened): Promise<string[][]> {
	await opened.input.parts.parseAll()

	return opened.deck.slides.map(ref => shapeTexts(opened.deck.nodes.get(ref)?.shapes ?? []).sort())
}

const PICTURE_DECK = odpBytes({
	body: page(
		'<draw:frame draw:name="Pic" svg:x="1cm" svg:y="1cm" svg:width="4cm" svg:height="4cm"><draw:image xlink:href="Pictures/a.png" xlink:type="simple"/></draw:frame>' +
			'<draw:frame draw:name="Clip" svg:x="6cm" svg:y="1cm" svg:width="8cm" svg:height="4.5cm"><draw:plugin xlink:href="Media/clip.mp4" xlink:type="simple" draw:mime-type="video/mp4"/></draw:frame>' +
			'<draw:custom-shape draw:name="Run" svg:x="1cm" svg:y="8cm" svg:width="4cm" svg:height="2cm"><office:event-listeners><presentation:event-listener script:event-name="dom:click" presentation:action="execute" xlink:href="calc.exe" xlink:type="simple"/></office:event-listeners><text:p>Pages: <text:page-count>3</text:page-count></text:p><draw:enhanced-geometry svg:viewBox="0 0 21600 21600" draw:type="rectangle"/></draw:custom-shape>'
	),
	extra: [
		{ name: "Pictures/a.png", data: FIXTURE_PNG, mediaType: "image/png" },
		{
			name: "Media/clip.mp4",
			data: new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]),
			mediaType: "video/mp4"
		}
	]
})

describe("presentation conversions", () => {
	it("writes an ODP deck as a .pptx with its slides, shapes, text, notes and slide jumps", async () => {
		const source = await odp(odpDeck())
		const before = await slideTexts(source)
		const { bytes } = await convert(source, "pptx")
		const back = await pptx(bytes)
		const after = await slideTexts(back)

		expect(back.deck.slides).toHaveLength(3)
		expect(after).toEqual(before)
		expect(after[0]).toEqual(expect.arrayContaining(["Hello bold world", "Box text"]))

		const [first, second] = back.deck.slides

		if (first === undefined || second === undefined) throw new Error("no slides")

		const notesRef = back.deck.nodes.get(first)?.notes

		if (notesRef === undefined || back.input.format !== "pptx") throw new Error("no notes")

		expect(shapeTexts((await back.input.parts.slide(notesRef)).shapes)).toContain("Notes one")

		const jump = back.deck.nodes.get(second)?.shapes.find(shape => shape.name === "Jump")

		expect(jump?.actions?.click).toEqual({ kind: "slide", slide: back.deck.slides[2] })
	})

	it("copies an ODF picture and medium into ppt/media, plays the medium, and says what it left out", async () => {
		const { bytes, losses } = await convert(await odp(PICTURE_DECK), "pptx")
		const entries = await entriesOf(bytes)
		const slide = text(entries.get("ppt/slides/slide1.xml"))

		expect(entries.get("ppt/media/image1.png")).toEqual(FIXTURE_PNG)
		expect([...entries.keys()].some(name => /^ppt\/media\/media\d+\.mp4$/u.test(name))).toBe(true)
		expect(slide).toContain("<a:videoFile r:link=")
		expect(slide).toContain("<p14:media")
		// The script is left out; the page count is the text it shows (the deck has one page).
		expect(slide).not.toContain("calc.exe")
		expect(await slideTexts(await pptx(bytes))).toEqual([["Pages: 1"]])
		expect(losses).toEqual(
			expect.arrayContaining([
				{ kind: "action", count: 1, slides: [1] },
				// The page count PresentationML has no field for.
				{ kind: "field", count: 1, slides: [1] },
				// A medium without a poster is shown with a plain one.
				{ kind: "media", count: 1 }
			])
		)
	})

	it("shows an SVG picture by a PNG beside it, the SVG in the blip's extension, as PowerPoint writes one", async () => {
		const svg = new TextEncoder().encode(
			'<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>'
		)
		const deck = odpBytes({
			body: page(
				'<draw:frame draw:name="Vector" svg:x="1cm" svg:y="1cm" svg:width="4cm" svg:height="4cm"><draw:image xlink:href="Pictures/v.svg" xlink:type="simple"/></draw:frame>'
			),
			extra: [{ name: "Pictures/v.svg", data: svg, mediaType: "image/svg+xml" }]
		})
		const asked: Uint8Array[] = []
		const sink = memorySink()
		const source = await odp(deck)
		const converted = await convertPresentation(source.deck, source.input, "pptx", sink, {
			svgPng: bytes => {
				asked.push(bytes)

				return Promise.resolve(FIXTURE_PNG)
			}
		})
		const entries = await entriesOf(sink.bytes())
		const slide = text(entries.get("ppt/slides/slide1.xml"))
		const rels = text(entries.get("ppt/slides/_rels/slide1.xml.rels"))
		const blip = /<a:blip r:embed="(rId\d+)"[^>]*>(.*?)<\/a:blip>/su.exec(slide)
		const target = (id: string | undefined): string | undefined =>
			new RegExp(`Id="${id ?? ""}"[^>]*Target="([^"]+)"`, "u").exec(rels)?.[1]

		expect("kind" in converted ? converted : converted.losses).toEqual([])
		expect(asked).toEqual([svg])
		expect(target(blip?.[1])).toMatch(/\.png$/u)
		expect(blip?.[2]).toContain("{96DAC541-7B7A-43D3-8B79-37D633B846F1}")
		expect(target(/<asvg:svgBlip [^>]*r:embed="(rId\d+)"/u.exec(blip?.[2] ?? "")?.[1])).toMatch(/\.svg$/u)
		expect(
			[...entries.values()].some(part => part.length === FIXTURE_PNG.length && part.every((byte, k) => byte === FIXTURE_PNG[k]))
		).toBe(true)
	})

	it("shows an SVG picture it cannot draw by a plain PNG, and says so", async () => {
		const deck = odpBytes({
			body: page(
				'<draw:frame draw:name="Vector" svg:x="1cm" svg:y="1cm" svg:width="4cm" svg:height="4cm"><draw:image xlink:href="Pictures/v.svg" xlink:type="simple"/></draw:frame>'
			),
			extra: [
				{
					name: "Pictures/v.svg",
					data: new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>'),
					mediaType: "image/svg+xml"
				}
			]
		})
		const { bytes, losses } = await convert(await odp(deck), "pptx")
		const slide = text((await entriesOf(bytes)).get("ppt/slides/slide1.xml"))

		expect(slide).toContain("asvg:svgBlip")
		expect(losses).toContainEqual({ kind: "picture", count: 1 })
	})

	it("keeps a placeholder that fits its text only through its layout at the box PowerPoint stored", async () => {
		const deck = buildPptx({
			layouts: [
				{
					name: "Fitted",
					type: "obj",
					shapes: sp(
						3,
						"Content Placeholder 2",
						'idx="1"',
						xfrm(150_000, 750_000, 2_900_000, 1_900_000),
						body("", "<a:bodyPr><a:spAutoFit/></a:bodyPr>")
					)
				}
			],
			slides: [
				{
					shapes:
						sp(5, "Body", 'idx="1"', xfrm(150_000, 750_000, 2_900_000, 3_000_000), body(para("Inherits the fit"))) +
						sp(
							6,
							"Box",
							undefined,
							xfrm(150_000, 4_000_000, 2_900_000, 500_000),
							body(para("Fits itself"), "<a:bodyPr><a:spAutoFit/></a:bodyPr>")
						)
				}
			]
		})
		const { bytes } = await convert(await pptx(deck), "odp")
		const content = text((await entriesOf(bytes)).get("content.xml"))
		const grows = (words: string): boolean => {
			const at = content.indexOf(words)
			const start = Math.max(content.lastIndexOf("<draw:frame ", at), content.lastIndexOf("<draw:custom-shape ", at))
			const style = /draw:style-name="([^"]+)"/u.exec(content.slice(start, content.indexOf(">", start)))?.[1] ?? ""
			const properties = new RegExp(`<style:style style:name="${style}"[^>]*>(.*?)</style:style>`, "su").exec(content)?.[1] ?? ""

			return properties.includes('draw:auto-grow-height="true"')
		}

		expect(grows("Inherits the fit")).toBe(false)
		expect(grows("Fits itself")).toBe(true)
	})

	it("writes a pptx deck as an .odp that reopens with its slides and text", async () => {
		const deck = buildPptx({
			slides: [
				{ shapes: sp(2, "Title", 'type="title"', xfrm(457200, 274638, 8229600, 1143000), body(para("Converted"))) },
				{ shapes: sp(2, "Title", 'type="title"', xfrm(457200, 274638, 8229600, 1143000), body(para("Second"))) }
			]
		})
		const source = await pptx(deck)
		const { bytes } = await convert(source, "odp")
		const back = await odp(bytes)

		expect(await slideTexts(back)).toEqual([["Converted"], ["Second"]])
		expect(text((await entriesOf(bytes)).get("content.xml"))).toContain('office:version="1.3"')
	})

	it("keeps a pptx slide's transition in the .odp with its exact duration", async () => {
		const deck = buildPptx({
			slides: [
				{
					shapes: sp(2, "Title", 'type="title"', xfrm(457200, 274638, 8229600, 1143000), body(para("Fades"))),
					after: '<p:transition spd="slow" p14:dur="1600" xmlns:p14="http://schemas.microsoft.com/office/powerpoint/2010/main"><p:fade/></p:transition>'
				}
			]
		})
		const { bytes } = await convert(await pptx(deck), "odp")
		const content = text((await entriesOf(bytes)).get("content.xml"))
		const id = /<draw:page [^>]*xml:id="([^"]+)"/u.exec(content)?.[1]

		expect(id).toBeDefined()
		expect(content).toContain(`<anim:par smil:begin="${id ?? ""}.begin"><anim:transitionFilter smil:dur="1.6s" smil:type="fade"`)
		expect(content).toMatch(/<style:drawing-page-properties[^>]*smil:type="fade"/u)
	})

	it("converts a PowerPoint 97–2003 deck to .odp with its own losses, and to .pptx as the package it opened as", async () => {
		const built = await buildPpt({
			slides: [{ shapes: [{ text: "Legacy", textType: 0, placeholder: { type: 13, position: 0 }, anchor: [100, 300, 5400, 700] }] }],
			png: FIXTURE_PNG
		})
		const toOdp = await convert(await ppt(built.bytes), "odp")

		expect(await slideTexts(await odp(toOdp.bytes))).toEqual([["Legacy"]])

		const toPptx = await convert(await ppt(built.bytes), "pptx")

		expect(await slideTexts(await pptx(toPptx.bytes))).toEqual([["Legacy"]])
	})

	it("seals a protected deck's .pptx copy under the source's sealer and refuses its .odp copy", async () => {
		const built = await buildPpt({
			slides: [{ shapes: [{ text: "Secret", anchor: [100, 300, 5400, 700] }] }],
			png: FIXTURE_PNG,
			password: "secret"
		})
		const source = await ppt(built.bytes, "secret")
		const sink = memorySink()

		expect(canConvertPresentation(source.deck, "odp")).toBe(false)
		expect(await convertPresentation(source.deck, source.input, "odp", sink)).toMatchObject({ kind: "refused", reason: "encrypted" })
		expect(await convertPresentation(source.deck, source.input, "pptx", sink)).toMatchObject({ kind: "refused", reason: "encrypted" })

		let sealed: Uint8Array | undefined
		const { bytes, size } = await convert(source, "pptx", zip => {
			sealed = zip

			return Promise.resolve(new Uint8Array([7, 7, 7]))
		})

		expect([...(sealed ?? new Uint8Array()).subarray(0, 2)]).toEqual([0x50, 0x4b])
		expect([...bytes]).toEqual([7, 7, 7])
		expect(size).toBe(3)
	})

	it("offers a PresentationML copy of a PresentationML deck only when it cannot be edited in place", async () => {
		const plain = await pptx(buildPptx({ slides: [{ shapes: "" }] }))

		expect(canConvertPresentation(plain.deck, "odp")).toBe(true)
		expect(canConvertPresentation(plain.deck, "pptx")).toBe(false)

		plain.deck.gate.push("strict")
		expect(canConvertPresentation(plain.deck, "pptx")).toBe(true)

		const fromOdp = await odp(odpDeck())

		expect(canConvertPresentation(fromOdp.deck, "pptx")).toBe(true)
		expect(canConvertPresentation(fromOdp.deck, "odp")).toBe(false)
	})

	it("names each fresh ODP writer loss by its kind", () => {
		const report = new ConversionReport()

		noteFresh(report, {
			approximated: {
				"gradient fill": 2,
				"dashed line": 1,
				"outline star5": 1,
				"spacing in percent of a line": 3,
				"table style": 1,
				chart: 2
			},
			omitted: { "chart frame": 1, "smartart frame": 1, "line end": 2, ink: 1, "shape (notImplemented)": 1, "kiosk restart": 1 }
		})

		expect(report.losses()).toEqual([
			{ kind: "chart", count: 1 },
			{ kind: "chartDetail", count: 2 },
			{ kind: "fill", count: 2 },
			{ kind: "geometry", count: 1 },
			{ kind: "ink", count: 1 },
			{ kind: "line", count: 3 },
			{ kind: "shape", count: 1 },
			{ kind: "showSettings", count: 1 },
			{ kind: "smartArt", count: 1 },
			{ kind: "tableStyle", count: 1 },
			{ kind: "text", count: 3 }
		])
	})

	it("gives an ODF field the GUID id PresentationML requires, the same one every time", () => {
		const id = fieldGuid("{odp-field-1}")

		expect(id).toMatch(/^\{[0-9A-F]{8}-[0-9A-F]{4}-4[0-9A-F]{3}-8[0-9A-F]{3}-[0-9A-F]{12}\}$/u)
		expect(fieldGuid("{odp-field-1}")).toBe(id)
		expect(fieldGuid("{odp-field-2}")).not.toBe(id)
		expect(fieldGuid("{B0C9E4F1-0A1B-4C2D-8E3F-123456789ABC}")).toBe("{B0C9E4F1-0A1B-4C2D-8E3F-123456789ABC}")
	})
})

const STRICT = join(CORPUS_DIR, "pptx", "docx4j__strict.pptx")
const SIGNED = join(CORPUS_DIR, "pptx", "poi__hello-world-signed.pptx")

describe.skipIf(!existsSync(STRICT) || !existsSync(SIGNED))("gated decks", () => {
	it("writes a Strict deck as a Transitional copy that opens editable with the same text", async () => {
		const source = await pptx(new Uint8Array(readFileSync(STRICT)))
		const before = await slideTexts(source)
		const { bytes } = await convert(source, "pptx")
		const entries = await entriesOf(bytes)
		const back = await pptx(bytes)

		expect(source.deck.gate).toEqual(["strict"])
		expect(back.deck.gate).toEqual([])
		expect(await slideTexts(back)).toEqual(before)
		expect([...entries.values()].some(part => text(part).includes("purl.oclc.org/ooxml"))).toBe(false)
	})

	it("reports the signature a signed deck's copy drops", async () => {
		const { bytes, losses } = await convert(await pptx(new Uint8Array(readFileSync(SIGNED))), "pptx")
		const back = await pptx(bytes)

		expect(losses).toEqual([{ kind: "signature", count: 1 }])
		expect(back.deck.gate).toEqual([])
		expect([...(await entriesOf(bytes)).keys()].some(name => name.includes("xmlsignatures"))).toBe(false)
	})

	it("reports the signature a signed deck's OpenDocument copy drops", async () => {
		const { losses } = await convert(await pptx(new Uint8Array(readFileSync(SIGNED))), "odp")

		expect(losses).toContainEqual({ kind: "signature", count: 1 })
	})
})

describe("write-reserved decks", () => {
	it("reports the write-reservation password an OpenDocument copy drops", async () => {
		const { losses } = await convert(await pptx(modifyVerifierPptx()), "odp")

		expect(losses).toContainEqual({ kind: "writeReservation", count: 1 })
	})
})

function corpus(directories: readonly string[]): string[] {
	return directories.flatMap(directory => {
		const path = join(CORPUS_DIR, directory)

		return existsSync(path) ? readdirSync(path).map(name => join(path, name)) : []
	})
}

const ODP_FILES = corpus(["odp", "otp"])
const PPT_FILES = corpus(["ppt", "pps", "pot"])

describe.skipIf(ODP_FILES.length === 0 || PPT_FILES.length === 0)("over the corpus", () => {
	it("converts every ODP deck to a .pptx that reopens with its slide count and text", { timeout: budget(900_000) }, async () => {
		const failures: string[] = []

		for (const path of ODP_FILES) {
			const source = await odp(new Uint8Array(readFileSync(path)))
			const before = await slideTexts(source)
			const { bytes } = await convert(source, "pptx")
			const after = await slideTexts(await pptx(bytes))

			if (after.length !== before.length) failures.push(`${path}: ${String(after.length)} slides`)
			// Every text of a slide is there (a field PresentationML has no type for shows its text as it read).
			else if (before.some((texts, index) => texts.length !== after[index]?.length)) failures.push(`${path}: shapes with text differ`)
		}

		expect(failures).toEqual([])
	})

	it(
		"converts every unencrypted PowerPoint 97–2003 deck to an .odp that reopens with its slide count and text",
		{ timeout: budget(900_000) },
		async () => {
			const failures: string[] = []

			for (const path of PPT_FILES) {
				const bytes = new Uint8Array(readFileSync(path))
				const probe = await pptToPptx(bytesSource(bytes))

				if (probe.kind !== "converted") continue

				const source = await ppt(bytes)
				const before = await slideTexts(source)
				const after = await slideTexts(await odp((await convert(source, "odp")).bytes))

				if (after.length !== before.length) failures.push(`${path}: ${String(after.length)} slides`)
				else if (before.some((texts, index) => texts.join("\n") !== after[index]?.join("\n")))
					failures.push(`${path}: text differs`)
			}

			expect(failures).toEqual([])
		}
	)
})
