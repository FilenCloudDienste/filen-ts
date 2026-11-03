import type { CommandResult } from "../dom/presentation/protocol"
import { describe, expect, it } from "vitest"
import type { Deck, ShapeNode, SlideNode, SlideRef } from "../core/presentation/model"
import { zipParts, type TemplatePart } from "../core/templates/zip"
import { odpParts } from "../dom/presentation/engine/open/odp"
import { galleryDesigns } from "../core/presentation/edit/apply/design"
import { filenTheme } from "../core/templates/themes/catalog"
import { themeName } from "../core/templates/themes/model"
import { odpGalleryMaster } from "../core/templates/themes/odp"
import { designDeck, designDeckParts, designOdp } from "./presentationDesignFixtures"
import { driveSession } from "./odpWriteDrive"
import { entriesOf, openOdpDeck } from "./odpWriteFixtures"
import { editHarness } from "./presentationEditFixtures"
import { image, png } from "./presentationObjectsFixtures"
import { partsOf, rebaseSession, saveEdits, text } from "./pptxWriteFixtures"

// Slide size changes that scale the content (Ensure fit, Maximize) and picture backgrounds, end to end through the
// pptx writer.

const A = "http://schemas.openxmlformats.org/drawingml/2006/main"
const P = "http://schemas.openxmlformats.org/presentationml/2006/main"
const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
const MC = "http://schemas.openxmlformats.org/markup-compatibility/2006"

const CELL = (value: string, margin = ""): string =>
	`<a:tc><a:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US" sz="2000"/><a:t>${value}</a:t></a:r></a:p></a:txBody><a:tcPr${margin}/></a:tc>`

const TABLE =
	'<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="4" name="Table 3"/><p:cNvGraphicFramePr><a:graphicFrameLocks noGrp="1"/></p:cNvGraphicFramePr><p:nvPr/></p:nvGraphicFramePr>' +
	'<p:xfrm><a:off x="838200" y="1825625"/><a:ext cx="10515600" cy="741680"/></p:xfrm>' +
	'<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl><a:tblPr firstRow="1"/>' +
	'<a:tblGrid><a:gridCol w="3505200"/><a:gridCol w="7010400"/></a:tblGrid>' +
	`<a:tr h="370840">${CELL("a", ' marL="182880"')}${CELL("b")}</a:tr>` +
	`<a:tr h="370840">${CELL("c")}${CELL("d")}</a:tr>` +
	"</a:tbl></a:graphicData></a:graphic></p:graphicFrame>"

// A shape inside mc:AlternateContent whose Choice the reader does not know: kept opaque, locked.
const ALTERNATE =
	`<mc:AlternateContent xmlns:mc="${MC}"><mc:Choice xmlns:zz="urn:example:unknown" Requires="zz">` +
	'<p:sp><p:nvSpPr><p:cNvPr id="5" name="Alt"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="11000000" y="6000000"/><a:ext cx="1000000" cy="500000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:sp>' +
	"</mc:Choice></mc:AlternateContent>"

// A shape in a branch the reader takes (p14, with its fallback copy): kept as written, its box rewritten in both
// branches when it moves.
const P14 = "http://schemas.microsoft.com/office/powerpoint/2010/main"
const KNOWN_SHAPE = (body: string): string =>
	'<p:sp><p:nvSpPr><p:cNvPr id="7" name="Kept"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="11000000" y="6000000"/><a:ext cx="1000000" cy="500000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>' +
	`${body}</p:sp>`
const KNOWN = (body: string): string =>
	`<mc:AlternateContent xmlns:mc="${MC}"><mc:Choice xmlns:p14="${P14}" Requires="p14">${KNOWN_SHAPE(body)}</mc:Choice><mc:Fallback>${KNOWN_SHAPE(body)}</mc:Fallback></mc:AlternateContent>`
// The same with text that states no size of its own (it takes its master's, which the change scales).
const KNOWN_INHERITED_TEXT = KNOWN('<p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US"/><a:t>y</a:t></a:r></a:p></p:txBody>')
// The same with text whose fallback states a size its Choice does not: no stated value of the read branch says how
// the other's scales.
const KNOWN_UNEVEN =
	`<mc:AlternateContent xmlns:mc="${MC}"><mc:Choice xmlns:p14="${P14}" Requires="p14">` +
	KNOWN_SHAPE('<p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US"/><a:t>y</a:t></a:r></a:p></p:txBody>') +
	"</mc:Choice><mc:Fallback>" +
	KNOWN_SHAPE('<p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US" sz="2400"/><a:t>y</a:t></a:r></a:p></p:txBody>') +
	"</mc:Fallback></mc:AlternateContent>"
// The same with text stating sizes, spacing, a bullet size and indents of its own, which a scale rewrites.
const KNOWN_TEXT = KNOWN(
	'<p:txBody><a:bodyPr/><a:lstStyle><a:lvl1pPr marL="914400" indent="-457200"><a:spcBef><a:spcPts val="1200"/></a:spcBef><a:defRPr sz="2800"/></a:lvl1pPr></a:lstStyle>' +
		'<a:p><a:pPr marL="685800" indent="-342900"><a:buSzPts val="2000"/></a:pPr><a:r><a:rPr lang="en-US" sz="2400"/><a:t>y</a:t></a:r><a:endParaRPr lang="en-US" sz="2400"/></a:p></p:txBody>'
)

const PLAIN =
	'<p:sp><p:nvSpPr><p:cNvPr id="6" name="Plain"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="11000000" y="6000000"/><a:ext cx="1000000" cy="500000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>' +
	'<p:txBody><a:bodyPr/><a:lstStyle><a:lvl1pPr><a:spcBef><a:spcPts val="1200"/></a:spcBef><a:defRPr sz="2800"/></a:lvl1pPr></a:lstStyle>' +
	'<a:p><a:pPr><a:buSzPts val="2000"/></a:pPr><a:r><a:rPr lang="en-US" sz="2400"/><a:t>x</a:t></a:r><a:endParaRPr lang="en-US" sz="2400"/></a:p></p:txBody></p:sp>'

// Paragraph indents in a list level and in a paragraph's own properties.
const INDENTED =
	'<p:sp><p:nvSpPr><p:cNvPr id="7" name="Indented"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="1000000" y="1000000"/><a:ext cx="6000000" cy="2000000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>' +
	'<p:txBody><a:bodyPr/><a:lstStyle><a:lvl1pPr marL="914400" indent="-457200"><a:defRPr sz="2800"/></a:lvl1pPr></a:lstStyle>' +
	'<a:p><a:pPr marL="685800" indent="-342900"/><a:r><a:rPr lang="en-US" sz="2400"/><a:t>x</a:t></a:r></a:p></p:txBody></p:sp>'

function slide(content: string): string {
	return (
		`<p:sld xmlns:a="${A}" xmlns:r="${R}" xmlns:p="${P}"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>` +
		'<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>' +
		`${content}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`
	)
}

function deck(content: string): Promise<Uint8Array> {
	const parts = designDeckParts(["title", "blank"]).map(([name, markup, stored]): TemplatePart =>
		name === "ppt/slides/slide2.xml" ? [name, slide(content)] : stored === undefined ? [name, markup] : [name, markup, stored]
	)

	return zipParts(parts)
}

const TO_4X3 = { family: "design", kind: "setSize", cx: 9_144_000, cy: 6_858_000, type: "screen4x3", scale: "ensureFit" } as const

function revisionOf(result: CommandResult): number {
	if (!result.ok) throw new Error(JSON.stringify(result))

	return result.revision
}

function media(parts: ReadonlyMap<string, Uint8Array>): string[] {
	return [...parts.keys()].filter(name => name.startsWith("ppt/media/"))
}

// Each absolute fo:font-size of a styles stream with the name of the style (or list style) holding it.
function styleSizes(markup: string): [string, number][] {
	const out: [string, number][] = []
	let name = ""

	for (const match of markup.matchAll(/<(?:style:style|style:default-style|text:list-style)\b[^>]*>|fo:font-size="([\d.]+)pt"/gu)) {
		if (match[1] === undefined) name = /style:name="([^"]*)"/u.exec(match[0])?.[1] ?? ""
		else out.push([name, Number(match[1])])
	}

	return out
}

function numbers(markup: string, pattern: RegExp): number[] {
	return [...markup.matchAll(pattern)].map(match => Number(match[1]))
}

describe("a scaled slide size change", () => {
	it("scales a table's columns, rows and cell margins with its frame", async () => {
		const bytes = await deck(TABLE)
		const h = await editHarness(bytes)
		const markup = text((await partsOf(await saveEdits(h, revisionOf(await h.command(TO_4X3))))).get("ppt/slides/slide2.xml"))
		const frame = Number(/<p:xfrm><a:off [^>]*\/><a:ext cx="(\d+)"/u.exec(markup)?.[1])
		const columns = numbers(markup, /<a:gridCol w="(\d+)"/gu)

		expect(frame).toBe(7_886_700)
		expect(columns).toEqual([2_628_900, 5_257_800])
		expect(numbers(markup, /<a:tr h="(\d+)"/gu)).toEqual([278_130, 278_130])
		// The written margin and the defaults (0.1", 0.05"), each × 0.75.
		expect(markup).toMatch(/<a:tcPr marL="137160" marR="68580" marT="34290" marB="34290"/u)
		expect(numbers(markup, /sz="(\d+)"/gu).every(size => size === 1500)).toBe(true)
		h.close()
	})

	it("scales the font sizes, point spacing and bullet sizes of every text, and undo puts them back exactly", async () => {
		const bytes = await deck(PLAIN)
		const h = await editHarness(bytes)
		const saved = await saveEdits(h, revisionOf(await h.command(TO_4X3)))
		const parts = await partsOf(saved)
		const markup = text(parts.get("ppt/slides/slide2.xml"))

		expect(markup).toContain('<a:defRPr sz="2100"/>')
		expect(markup).toContain('<a:spcPts val="900"/>')
		expect(markup).toContain('<a:buSzPts val="1500"/>')
		expect(numbers(markup, /<a:(?:rPr|endParaRPr) lang="en-US" sz="(\d+)"/gu)).toEqual([1800, 1800])

		// The master's text styles and the deck's default text style scale too (the template's title is 44 pt).
		expect(text(parts.get("ppt/slideMasters/slideMaster1.xml"))).toMatch(/<p:titleStyle><a:lvl1pPr[^>]*>.*?<a:defRPr[^>]* sz="3300"/su)
		expect(text(parts.get("ppt/presentation.xml"))).toMatch(/<p:defaultTextStyle>.*<a:defRPr[^>]* sz="1350"/su)

		await rebaseSession(h, bytes, saved)

		const undone = await h.undo()
		const back = await partsOf(await saveEdits(h, revisionOf(undone)))
		const source = await partsOf(bytes)

		for (const name of ["ppt/slides/slide2.xml", "ppt/presentation.xml"])
			expect(text(back.get(name)), name).toBe(text(source.get(name)))

		// The master's text styles are written from the model again: the same values.
		const values = (markup: string): string[] => markup.match(/(?:sz|val)="\d+"/gu) ?? []

		expect(values(text(back.get("ppt/slideMasters/slideMaster1.xml")))).toEqual(
			values(text(source.get("ppt/slideMasters/slideMaster1.xml")))
		)

		h.close()
	})

	it("scales paragraph and list level indents with the text, and undo puts them back exactly", async () => {
		const bytes = await deck(INDENTED)
		const h = await editHarness(bytes)
		const saved = await saveEdits(h, revisionOf(await h.command(TO_4X3)))
		const parts = await partsOf(saved)
		const markup = text(parts.get("ppt/slides/slide2.xml"))

		expect(markup).toMatch(/<a:lvl1pPr marL="685800" indent="-342900"/u)
		expect(markup).toMatch(/<a:pPr marL="514350" indent="-257175"/u)

		// The master's text styles' indents scale too.
		const indents = (markup: string): number[] => numbers(markup, /\b(?:marL|indent)="(-?\d+)"/gu)
		const source = await partsOf(bytes)
		const master = indents(text(source.get("ppt/slideMasters/slideMaster1.xml")))

		expect(master.some(value => value !== 0)).toBe(true)
		expect(indents(text(parts.get("ppt/slideMasters/slideMaster1.xml")))).toEqual(master.map(value => Math.round(value * 0.75)))

		await rebaseSession(h, bytes, saved)

		const back = await partsOf(await saveEdits(h, revisionOf(await h.undo())))

		expect(text(back.get("ppt/slides/slide2.xml"))).toBe(text(source.get("ppt/slides/slide2.xml")))
		expect(indents(text(back.get("ppt/slideMasters/slideMaster1.xml")))).toEqual(master)
		h.close()
	})

	it("leaves the text sizes alone when the content keeps its scale", async () => {
		const bytes = await designDeck(["title", "obj"], {})
		const h = await editHarness(bytes)
		// 4:3 to 16:9 with Ensure fit: the scale is 1, the content only centred.
		const narrow = await h.command(TO_4X3)
		const saved = await saveEdits(h, revisionOf(narrow))

		await rebaseSession(h, bytes, saved)

		const before = await partsOf(saved)
		const wide = await h.command({ family: "design", kind: "setSize", cx: 12_192_000, cy: 6_858_000, scale: "ensureFit" })
		const after = await partsOf(await saveEdits(h, revisionOf(wide)))

		expect(text(after.get("ppt/slideMasters/slideMaster1.xml")).match(/sz="\d+"/gu)).toEqual(
			text(before.get("ppt/slideMasters/slideMaster1.xml")).match(/sz="\d+"/gu)
		)
		h.close()
	})

	it("moves and scales a shape kept as written with the others when only its box changes", async () => {
		const h = await editHarness(await deck(KNOWN("") + PLAIN))
		const parts = await partsOf(await saveEdits(h, revisionOf(await h.command(TO_4X3))))
		const markup = text(parts.get("ppt/slides/slide2.xml"))
		// 16:9 to 4:3, Ensure fit: s = 0.75, the content centred vertically (dy = 857250); both branches' copies.
		const boxes = [...markup.matchAll(/name="Kept".*?<a:off x="(\d+)" y="(\d+)"\/><a:ext cx="(\d+)" cy="(\d+)"\/>/gsu)].map(match =>
			match.slice(1).map(Number)
		)

		expect(boxes).toEqual([
			[8_250_000, 5_357_250, 750_000, 375_000],
			[8_250_000, 5_357_250, 750_000, 375_000]
		])
		h.close()
	})

	it("scales a kept shape whose text states no size: its box in both branches, its text as written", async () => {
		const bytes = await deck(KNOWN_INHERITED_TEXT + PLAIN)
		const h = await editHarness(bytes)
		const saved = await saveEdits(h, revisionOf(await h.command(TO_4X3)))
		const markup = text((await partsOf(saved)).get("ppt/slides/slide2.xml"))
		const boxes = [...markup.matchAll(/name="Kept".*?<a:off x="(\d+)" y="(\d+)"\/><a:ext cx="(\d+)" cy="(\d+)"\/>/gsu)].map(match =>
			match.slice(1).map(Number)
		)

		expect(boxes).toEqual([
			[8_250_000, 5_357_250, 750_000, 375_000],
			[8_250_000, 5_357_250, 750_000, 375_000]
		])
		expect(markup.match(/<a:p><a:r><a:rPr lang="en-US"\/><a:t>y<\/a:t><\/a:r><\/a:p>/gu)).toHaveLength(2)
		h.close()

		// Reopened, the saved deck reads the kept shape at its new box.
		const again = await editHarness(saved)
		const kept = (await again.slide(1)).shapes.find(shape => shape.name === "Kept")

		expect(kept?.xfrm).toMatchObject({ x: 8_250_000, y: 5_357_250, cx: 750_000, cy: 375_000 })
		again.close()
	})

	it("scales a kept shape's stated text values in both branches, and undo after the save puts them back exactly", async () => {
		const bytes = await deck(KNOWN_TEXT + PLAIN)
		const h = await editHarness(bytes)
		const saved = await saveEdits(h, revisionOf(await h.command(TO_4X3)))
		const markup = text((await partsOf(saved)).get("ppt/slides/slide2.xml"))
		const kept = [...markup.matchAll(/<p:sp><p:nvSpPr><p:cNvPr id="7" name="Kept"\/>.*?<\/p:sp>/gsu)].map(match => match[0])

		expect(kept).toHaveLength(2)

		for (const copy of kept) {
			expect(copy).toContain('<a:off x="8250000" y="5357250"/><a:ext cx="750000" cy="375000"/>')
			expect(copy).toContain(
				'<a:lvl1pPr marL="685800" indent="-342900"><a:spcBef><a:spcPts val="900"/></a:spcBef><a:defRPr sz="2100"/>'
			)
			expect(copy).toContain('<a:pPr marL="514350" indent="-257175"><a:buSzPts val="1500"/></a:pPr>')
			expect(copy).toContain('<a:rPr lang="en-US" sz="1800"/>')
			expect(copy).toContain('<a:endParaRPr lang="en-US" sz="1800"/>')
		}

		// Reopened, the kept shape reads at its scaled sizes, and saves again unchanged.
		const again = await editHarness(saved)
		const shape = (await again.slide(1)).shapes.find(each => each.name === "Kept")

		expect(shape?.text?.paragraphs[0]?.runs[0]).toMatchObject({ rPr: { sz: 1800 } })
		again.close()

		await rebaseSession(h, bytes, saved)

		const back = await partsOf(await saveEdits(h, revisionOf(await h.undo())))

		expect(text(back.get("ppt/slides/slide2.xml"))).toBe(text((await partsOf(bytes)).get("ppt/slides/slide2.xml")))
		h.close()
	})

	it("refuses a change whose scale a kept shape's other branch could not follow", async () => {
		const h = await editHarness(await deck(KNOWN_UNEVEN + PLAIN))

		expect(await h.command(TO_4X3)).toMatchObject({ ok: false, refusal: "locked" })

		// Without scaling the content, its text keeps its size and it only moves: the change applies.
		expect((await h.command({ ...TO_4X3, scale: "none" })).ok).toBe(true)
		h.close()
	})

	it("refuses a change that would leave a shape it cannot read where it was", async () => {
		const h = await editHarness(await deck(ALTERNATE + PLAIN))

		expect(await h.command(TO_4X3)).toMatchObject({ ok: false, refusal: "locked" })

		// Without scaling the content, nothing moves: the change applies.
		expect((await h.command({ ...TO_4X3, scale: "none" })).ok).toBe(true)
		h.close()
	})
})

describe("a scaled slide size change on an ODP deck", () => {
	it("scales the pages' text and the font sizes of styles.xml, and an undo after the save scales them back", async () => {
		const bytes = await designOdp(2)
		const d = await driveSession(bytes)
		const fontSizes = (markup: string): number[] => numbers(markup, /fo:font-size="([\d.]+)pt"/gu)
		const before = await entriesOf(bytes)

		expect((await d.command({ family: "design", kind: "setSize", cx: 9_144_000, cy: 6_858_000, scale: "ensureFit" })).ok).toBe(true)

		const saved = await d.save()
		const entries = await entriesOf(saved.bytes ?? new Uint8Array())

		// Every absolute size × s but the notes styles' (a notes page keeps its size, and its text with it).
		expect(styleSizes(text(entries.get("styles.xml")))).toEqual(
			styleSizes(text(before.get("styles.xml"))).map(([name, size]) => [name, name.endsWith("-notes") ? size : size * 0.75])
		)
		expect(fontSizes(text(entries.get("content.xml")))).toContain(45)

		expect((await d.undo()).ok).toBe(true)

		const back = await d.save()

		expect(fontSizes(text((await entriesOf(back.bytes ?? new Uint8Array())).get("styles.xml")))).toEqual(
			fontSizes(text(before.get("styles.xml")))
		)
	})
})

const NOTES = (style: string): string =>
	`<presentation:notes><draw:frame presentation:style-name="${style}" draw:layer="layout" svg:x="2cm" svg:y="14cm" svg:width="17cm" svg:height="10cm" presentation:class="notes"><draw:text-box><text:p>Notes</text:p></draw:text-box></draw:frame></presentation:notes>`

describe("a scaled slide size change on an ODP deck with a gallery master an earlier save wrote", () => {
	it("writes the gallery design's styles at the sizes the theme makes them, never scaled", async () => {
		const d = await driveSession(await designOdp(2))
		const deck = d.session.deck

		expect(
			(
				await d.command({
					family: "design",
					kind: "setTheme",
					theme: { kind: "gallery", id: "slate", variant: 0 },
					slides: [...deck.slides]
				})
			).ok
		).toBe(true)
		expect((await d.save()).result.kind).toBe("written")
		expect((await d.command({ family: "design", kind: "setSize", cx: 9_144_000, cy: 6_858_000, scale: "ensureFit" })).ok).toBe(true)

		const saved = await d.save()
		const design = [...galleryDesigns(deck).values()][0]
		const theme = filenTheme("slate")

		if (design === undefined || theme === undefined) throw new Error("no gallery design")

		const made = odpGalleryMaster(theme, 0, deck.size, design.names.master, themeName(theme, 0))
		const owned = ([name]: [string, number]): boolean =>
			name === design.names.master || name.startsWith(`${design.names.master}_`) || name.startsWith(`${design.names.master}-`)
		const written = styleSizes(text((await entriesOf(saved.bytes ?? new Uint8Array())).get("styles.xml"))).filter(owned)

		expect(written.length).toBeGreaterThan(0)
		expect(written).toEqual(styleSizes(made.styles + made.automatic))
	})
})

// Each page's subtitle given an automatic style of its own (a font size and point spacing over its master's), the
// first page's notes frame sharing the title's automatic style, the second's taking the master's notes style.
const OWN_STYLES = (markup: string): string =>
	markup
		.replace(
			"</office:automatic-styles>",
			'<style:style style:name="prS" style:family="presentation" style:parent-style-name="Filen-subtitle">' +
				'<style:paragraph-properties fo:margin-top="0.5cm" fo:line-height="30pt"/>' +
				'<style:text-properties fo:font-size="32pt" style:font-size-asian="32pt" style:font-size-complex="32pt"/></style:style>' +
				"</office:automatic-styles>"
		)
		.replaceAll('presentation:style-name="Filen-subtitle"', 'presentation:style-name="prS"')
		.replace(
			/<\/draw:page>(.*?)<\/draw:page>/su,
			(_, between: string) => `${NOTES("pr1")}</draw:page>${between}${NOTES("Filen-notes")}</draw:page>`
		)

type TextView = { readonly name: string; readonly lstStyle: unknown; readonly runs: unknown }

// What a shape's text says about sizes, per shape of each page and its notes: its levels and its runs' properties.
async function textViews(deck: Deck, slideOf: (ref: SlideRef) => Promise<SlideNode>): Promise<TextView[][]> {
	const out: TextView[][] = []

	for (const ref of deck.slides) {
		const slide = await slideOf(ref)
		const notes = slide.notes === undefined ? undefined : deck.nodes.get(slide.notes)

		out.push(
			[...slide.shapes, ...(notes?.shapes ?? [])]
				.filter(shape => shape.text !== undefined)
				.map(shape => ({
					name: shape.name,
					lstStyle: JSON.parse(JSON.stringify(shape.text?.lstStyle ?? null)) as unknown,
					runs: JSON.parse(
						JSON.stringify(
							shape.text?.paragraphs.map(paragraph => [
								paragraph.runs.map(run => (run.kind === "opaque" ? null : run.rPr)),
								paragraph.endRPr ?? null
							])
						)
					) as unknown
				}))
		)
	}

	return out
}

async function reopened(bytes: Uint8Array | undefined): Promise<TextView[][]> {
	const opened = await openOdpDeck(bytes ?? new Uint8Array(), false)

	return textViews(opened.deck, ref => opened.parts.slide(ref))
}

async function sessionViews(d: Awaited<ReturnType<typeof driveSession>>): Promise<TextView[][]> {
	const parts = odpParts(d.session.deck)

	if (parts === undefined) throw new Error("not an ODP session")

	return textViews(d.session.deck, ref => parts.slide(ref))
}

describe("a scaled slide size change on an ODP deck, its shapes' own text styles", () => {
	it("are written at the session's sizes, so a reopened deck reads every shape's levels and runs as the session had them, and an undo after the save puts them back", async () => {
		const bytes = await designOdp(2, OWN_STYLES)
		const d = await driveSession(bytes)
		const original = await sessionViews(d)

		expect((await d.command({ family: "design", kind: "setSize", cx: 9_144_000, cy: 6_858_000, scale: "ensureFit" })).ok).toBe(true)

		const session = await sessionViews(d)

		expect(session).not.toEqual(original)

		const saved = await d.save()

		expect(saved.result.kind).toBe("written")
		expect(await reopened(saved.bytes)).toEqual(session)

		expect((await d.undo()).ok).toBe(true)

		const back = await d.save()

		expect(back.result.kind).toBe("written")
		expect(await reopened(back.bytes)).toEqual(original)
	})
})

describe("a picture background", () => {
	it("is stored once however many slides use it, and stays one part after a save rebases the session", async () => {
		const bytes = await designDeck(["title", "obj", "obj", "blank"])
		const h = await editHarness(bytes)
		const picture = { bytes: png(64, 64), contentType: "image/png", width: 64, height: 64 }
		const result = await h.command({
			family: "design",
			kind: "setBackground",
			slides: [...h.session.deck.slides],
			background: { kind: "fill", fill: { kind: "picture" } },
			image: picture
		} as never)
		const saved = await saveEdits(h, revisionOf(result))
		const parts = await partsOf(saved)

		expect(media(parts)).toEqual(["ppt/media/image1.png"])

		for (let index = 1; index <= 4; index++)
			expect(text(parts.get(`ppt/slides/_rels/slide${String(index)}.xml.rels`))).toContain('Target="../media/image1.png"')

		await rebaseSession(h, bytes, saved)

		const first = h.session.deck.slides[0]

		if (first === undefined) throw new Error("no slide")

		const again = await h.command({ family: "design", kind: "setBackground", slides: [first], background: undefined })

		expect(media(await partsOf(await saveEdits(h, revisionOf(again))))).toEqual(["ppt/media/image1.png"])
		h.close()
	})

	it("is written on slides whose part is rewritten whole in the same save (a size change with it)", async () => {
		const h = await editHarness(await designDeck(["title", "obj"]))

		revisionOf(
			await h.command({
				family: "design",
				kind: "setBackground",
				slides: [...h.session.deck.slides],
				background: { kind: "fill", fill: { kind: "picture" } },
				image: { bytes: png(64, 64), contentType: "image/png", width: 64, height: 64 }
			} as never)
		)

		const parts = await partsOf(await saveEdits(h, revisionOf(await h.command(TO_4X3))))

		expect(media(parts)).toEqual(["ppt/media/image1.png"])
		expect(text(parts.get("ppt/slides/slide2.xml"))).toMatch(/<p:bg><p:bgPr><a:blipFill[^>]*><a:blip r:embed="rId\d+"/u)
		h.close()
	})

	it("shares one part with a picture inserted once and duplicated before the first save", async () => {
		const h = await editHarness(await designDeck(["title"]))
		const slide = h.session.deck.slides[0]

		if (slide === undefined) throw new Error("no slide")

		const shape: ShapeNode = {
			id: 0,
			name: "Picture",
			hidden: false,
			kind: "pic",
			xfrm: { x: 500, y: 600, cx: 2000, cy: 1000, rot: 0, flipH: false, flipV: false }
		}

		revisionOf(await h.command({ family: "picture", kind: "insert", slide, shape, image: image() }))

		const parts = await partsOf(await saveEdits(h, revisionOf(await h.command({ family: "slide", kind: "duplicate", slide }))))

		expect(media(parts)).toHaveLength(1)
		h.close()
	})
})
