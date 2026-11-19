import { describe, expect, it } from "vitest"
import { insertPictureOp, insertTableOp } from "../core/presentation/edit/commands/insert"
import type { DeckOp } from "../core/presentation/edit/ops"
import { boxMarkup } from "../core/odp/write/emit/shape"
import type { ShapeNode, SlideNode, SlideRef, TextBody } from "../core/presentation/model"
import { review } from "../dom/presentation/engine/review"
import { odpBytes, page } from "./odpFixtures"
import { driveSession } from "./odpWriteDrive"
import { partsOf } from "./pptxWriteFixtures"
import { image } from "./presentationObjectsFixtures"

// The same state of an ODP deck saved twice in a session (an undo back to it, a redo forward to it, across saves and
// rebases) is written as the same bytes; and a text body the save writes again keeps the source's list header and the
// span style properties the model does not carry.

// A title in a list header (no bullet, its own list style) whose span sets East Asian and complex fonts with their
// pitch (properties the model reads no further than the family).
const TITLE_DECK = {
	automatic:
		'<style:style style:name="P1" style:family="paragraph"><style:paragraph-properties fo:text-align="center"/></style:style>' +
		'<style:style style:name="T1" style:family="text"><style:text-properties style:font-family-asian="Song" style:font-pitch-asian="variable" style:font-family-complex="Song" style:font-pitch-complex="variable"/></style:style>' +
		'<text:list-style style:name="L1"><text:list-level-style-number text:level="1" style:num-format=""><style:list-level-properties/></text:list-level-style-number></text:list-style>',
	body:
		page(
			'<draw:frame presentation:class="title" svg:x="2cm" svg:y="1cm" svg:width="24cm" svg:height="3cm"><draw:text-box>' +
				'<text:list text:style-name="L1"><text:list-header><text:p text:style-name="P1"><text:span text:style-name="T1">Agenda</text:span></text:p></text:list-header></text:list>' +
				"</draw:text-box></draw:frame>"
		) +
		'<draw:page draw:name="second" draw:master-page-name="M"><draw:frame presentation:class="title" svg:x="2cm" svg:y="1cm" svg:width="24cm" svg:height="3cm"><draw:text-box><text:p>Two</text:p></draw:text-box></draw:frame></draw:page>'
}

const decode = (bytes: Uint8Array | undefined): string => (bytes === undefined ? "" : new TextDecoder().decode(bytes))

async function contentOf(bytes: Uint8Array | undefined): Promise<string> {
	if (bytes === undefined) throw new Error("not written")

	return decode((await partsOf(bytes)).get("content.xml"))
}

function titleOf(node: SlideNode): ShapeNode {
	const shape = node.shapes.find(candidate => candidate.text !== undefined)

	if (shape === undefined) throw new Error("no title")

	return shape
}

function plain(text: string): TextBody {
	return { bodyPr: {}, paragraphs: [{ pPr: {}, runs: [{ kind: "r", text, rPr: {} }] }] }
}

describe("an ODP text body after a duplicate and a save", () => {
	it("undoing an edit writes the body back as the source had it", async () => {
		const d = await driveSession(odpBytes(TITLE_DECK), "odp")
		const first = d.session.deck.slides[0] as SlideRef

		expect((await d.command({ family: "slide", kind: "duplicate", slide: first })).ok).toBe(true)

		const saved = await contentOf((await d.save()).bytes)

		await review(d.context, first, { comments: false })

		const title = titleOf(d.session.deck.nodes.get(first) as SlideNode)

		expect(
			(await d.command({ family: "text", kind: "setText", target: { slide: first, id: title.id }, body: plain("edited") })).ok
		).toBe(true)
		expect((await d.save()).result.kind).toBe("written")
		expect((await d.undo()).ok).toBe(true)

		expect(await contentOf((await d.save()).bytes)).toBe(saved)
	})
})

describe("an ODP text body the save writes again", () => {
	it("keeps its list header and list style, and a span's style when its run reads the same", async () => {
		const d = await driveSession(odpBytes(TITLE_DECK), "odp")
		const first = d.session.deck.slides[0] as SlideRef

		await review(d.context, first, { comments: false })

		const title = titleOf(d.session.deck.nodes.get(first) as SlideNode)
		const body = title.text as TextBody
		const edited: TextBody = {
			...body,
			paragraphs: body.paragraphs.map(paragraph => ({
				...paragraph,
				runs: paragraph.runs.map(run => (run.kind === "r" ? { ...run, text: "Agenda two" } : run))
			}))
		}

		expect(
			(await d.command({ family: "text", kind: "setText", target: { slide: first, id: title.id }, body: edited } as DeckOp)).ok
		).toBe(true)

		const content = await contentOf((await d.save()).bytes)

		expect(content).toContain(
			'<text:list text:style-name="L1"><text:list-header><text:p text:style-name="P1"><text:span text:style-name="T1">Agenda two</text:span></text:p></text:list-header></text:list>'
		)
		expect(content).toContain('style:font-pitch-asian="variable"')
	})
})

// A pretty-printed page (each shape on its own line), a picture whose graphic style says style:mirror="none" and a
// custom shape whose outline says draw:mirror-horizontal="false".
const PRETTY_DECK = {
	automatic:
		'<style:style style:name="gr1" style:family="graphic"><style:graphic-properties draw:stroke="none" draw:fill="none" style:mirror="none"/></style:style>',
	body:
		'<draw:page draw:name="one" draw:master-page-name="M">\n\t\t\t' +
		'<draw:frame draw:style-name="gr1" svg:x="2cm" svg:y="2cm" svg:width="4cm" svg:height="3cm"><draw:image xlink:href="Pictures/p.png"/></draw:frame>\n\t\t\t' +
		'<draw:custom-shape svg:x="10cm" svg:y="2cm" svg:width="4cm" svg:height="3cm"><draw:enhanced-geometry draw:mirror-horizontal="false" draw:mirror-vertical="false" svg:viewBox="0 0 21600 21600" draw:type="right-arrow" draw:enhanced-path="M 0 0 L 21600 0 21600 21600 0 21600 Z N"/></draw:custom-shape>\n\t\t' +
		"</draw:page>" +
		'<draw:page draw:name="two" draw:master-page-name="M"/>',
	extra: [{ name: "Pictures/p.png", data: image(4, 3).bytes, mediaType: "image/png" }]
}

describe("the same ODP state saved after an undo of everything and a redo of everything", () => {
	it("writes the same bytes: flips turned off and on again, a shape added to a pretty-printed page", async () => {
		const d = await driveSession(odpBytes(PRETTY_DECK), "odp")
		const first = d.session.deck.slides[0] as SlideRef

		await review(d.context, first, { comments: false })

		const node = d.session.deck.nodes.get(first) as SlideNode
		const ops: DeckOp[] = node.shapes.flatMap(shape =>
			shape.xfrm === undefined
				? []
				: [
						{
							family: "shape",
							kind: "setXfrm",
							target: { slide: first, id: shape.id },
							xfrm: { ...shape.xfrm, flipH: true }
						} as DeckOp
					]
		)

		ops.push({
			family: "picture",
			kind: "insert",
			slide: first,
			shape: {
				id: 0,
				name: "P",
				hidden: false,
				kind: "pic",
				xfrm: { x: 0, y: 0, cx: 900_000, cy: 600_000, rot: 0, flipH: false, flipV: false }
			},
			image: image(12, 7)
		})

		expect(ops).toHaveLength(3)

		for (const op of ops) expect((await d.command(op)).ok).toBe(true)

		const saved = await contentOf((await d.save()).bytes)

		for (const _op of ops) expect((await d.undo()).ok).toBe(true)

		const undone = await contentOf((await d.save()).bytes)

		// Off again, each flip writes the source's explicit value in place, and the page keeps its indentation.
		expect(undone).toContain('<draw:enhanced-geometry draw:mirror-horizontal="false" draw:mirror-vertical="false"')
		expect(undone).toContain('style:mirror="none"')
		expect(undone).toContain("</draw:frame>\n\t\t\t<draw:custom-shape")

		for (const _op of ops) expect((await d.redo()).ok).toBe(true)

		expect(await contentOf((await d.save()).bytes)).toBe(saved)
	})
})

// Three paragraphs, each with its own id, appearing one by one (anim:set on smil:targetElement, LibreOffice's form).
const ANIMATED_DECK = {
	body:
		'<draw:page draw:name="one" draw:master-page-name="M"><draw:frame presentation:class="subtitle" svg:x="2cm" svg:y="2cm" svg:width="20cm" svg:height="10cm"><draw:text-box>' +
		'<text:p xml:id="id1" text:id="id1">First</text:p><text:p xml:id="id2" text:id="id2">Second</text:p><text:p xml:id="id3" text:id="id3">Third</text:p>' +
		'</draw:text-box></draw:frame><anim:par presentation:node-type="timing-root"><anim:seq presentation:node-type="main-sequence">' +
		["id1", "id2", "id3"]
			.map(
				id =>
					'<anim:par smil:begin="next"><anim:par smil:begin="0s"><anim:par smil:begin="0s" smil:fill="hold" presentation:node-type="on-click" presentation:preset-class="entrance" presentation:preset-id="ooo-entrance-appear">' +
					`<anim:set smil:begin="0s" smil:dur="0.001s" smil:fill="hold" smil:targetElement="${id}" anim:sub-item="text" smil:attributeName="visibility" smil:to="visible"/></anim:par></anim:par></anim:par>`
			)
			.join("") +
		"</anim:seq></anim:par></draw:page>" +
		'<draw:page draw:name="two" draw:master-page-name="M"/>'
}

// Every smil:targetElement of a content.xml that names no xml:id there.
function dangling(content: string): string[] {
	const ids = new Set([...content.matchAll(/xml:id=(?:"([^"]*)"|'([^']*)')/gu)].map(match => match[1] ?? match[2]))

	return [...content.matchAll(/smil:targetElement="([^"]*)"/gu)].map(match => match[1] ?? "").filter(id => !ids.has(id))
}

// The animated deck with its paragraphs' start tags spelled otherwise: ids in single quotes, a ">" in another
// attribute's value, a character reference in a style name.
const SPELLINGS: Readonly<Record<string, (body: string) => string>> = {
	"as LibreOffice writes them": body => body,
	"with single-quoted ids": body => body.replace(/xml:id="(id\d)" text:id="(id\d)"/gu, "xml:id='$1' text:id='$2'"),
	'with a ">" in another attribute': body => body.replace('<text:p xml:id="id2"', '<text:p foo:q="1>2" xmlns:foo="urn:y" xml:id="id2"'),
	"with a character reference in a style name": body =>
		body.replace('<text:p xml:id="id3"', '<text:p text:style-name="&#x50;1" xml:id="id3"')
}

describe("an ODP body whose paragraphs effects target, edited, saved and undone", () => {
	it.each(Object.keys(SPELLINGS))("is written back as the source had it, every effect naming its paragraph, %s", async spelling => {
		const respell = SPELLINGS[spelling] ?? (body => body)
		const source = odpBytes({
			automatic:
				'<style:style style:name="P1" style:family="paragraph"><style:paragraph-properties fo:text-align="center"/></style:style>',
			body: respell(ANIMATED_DECK.body)
		})
		const original = await contentOf(source)
		const d = await driveSession(source, "odp")
		const first = d.session.deck.slides[0] as SlideRef

		await review(d.context, first, { comments: false })

		const shape = titleOf(d.session.deck.nodes.get(first) as SlideNode)
		const body = shape.text as TextBody
		const edited: TextBody = {
			...body,
			paragraphs: body.paragraphs.map((paragraph, k) =>
				k === 1 ? { ...paragraph, runs: [...paragraph.runs, { kind: "r", text: "Z", rPr: {} }] } : paragraph
			)
		}

		expect((await d.command({ family: "text", kind: "setText", target: { slide: first, id: shape.id }, body: edited })).ok).toBe(true)

		const saved = await contentOf((await d.save()).bytes)

		expect(dangling(saved)).toEqual([])

		expect((await d.undo()).ok).toBe(true)

		const undone = await contentOf((await d.save()).bytes)

		expect(dangling(undone)).toEqual([])
		expect(undone).toBe(original)
	})
})

describe("an ODP page whose start tag the save writes again", () => {
	it("keeps its attributes as the source spells them: an undo after a save writes the source", async () => {
		const source = odpBytes({
			body:
				'<draw:page draw:name=\'Two&#x0a;lines\' draw:master-page-name="M"><draw:frame presentation:class="title" svg:x="2cm" svg:y="1cm" svg:width="24cm" svg:height="3cm"><draw:text-box><text:p>Title</text:p></draw:text-box></draw:frame></draw:page>' +
				'<draw:page draw:name="two" draw:master-page-name="M"/>'
		})
		const original = await contentOf(source)
		const d = await driveSession(source, "odp")
		const first = d.session.deck.slides[0] as SlideRef

		await review(d.context, first, { comments: false })

		const title = titleOf(d.session.deck.nodes.get(first) as SlideNode)

		expect(
			(await d.command({ family: "text", kind: "setText", target: { slide: first, id: title.id }, body: plain("edited") })).ok
		).toBe(true)
		expect((await d.save()).result.kind).toBe("written")
		expect((await d.undo()).ok).toBe(true)
		expect(await contentOf((await d.save()).bytes)).toBe(original)
	})
})

// A table and a picture inserted turned are written as the shape writer writes a turned box (boxAttributes): after
// the rebase, a later save of their page copies them as the first save wrote them.
describe("ODP frames inserted turned", () => {
	it("are copied unchanged by the next save of their page", async () => {
		const d = await driveSession(odpBytes(PRETTY_DECK), "odp")
		const first = d.session.deck.slides[0] as SlideRef

		await review(d.context, first, { comments: false })

		const turned = { x: 1_234_567, y: 765_431, cx: 2_345_679, cy: 1_234_573, rot: 1_234_567, flipH: false, flipV: false }
		const table = insertTableOp(d.session.deck, first, 2, 2, 0) as Extract<DeckOp, { kind: "insert" }>

		expect((await d.command({ ...table, shape: { ...table.shape, xfrm: turned } } as DeckOp)).ok).toBe(true)
		expect((await d.command(insertPictureOp(d.session.deck, first, image(12, 7), 0, "p.png", { ...turned, y: 3_456_789 }))).ok).toBe(
			true
		)

		const frames = (content: string): string[] =>
			[...content.matchAll(/<draw:frame[^>]*draw:transform="[^"]*"[^>]*>/gu)].map(match => match[0])
		const saved = frames(await contentOf((await d.save()).bytes))

		expect(saved).toHaveLength(2)
		// Written as the shape writer writes a turned box (the reader's rounding taken into account).
		expect(saved[0]).toContain(boxMarkup(turned))
		expect(saved[1]).toContain(boxMarkup({ ...turned, y: 3_456_789 }))

		const node = d.session.deck.nodes.get(first) as SlideNode
		const other = node.shapes.find(shape => shape.kind === "sp") as ShapeNode

		expect((await d.command({ family: "shape", kind: "setName", target: { slide: first, id: other.id }, name: "Renamed" })).ok).toBe(
			true
		)
		expect(frames(await contentOf((await d.save()).bytes))).toEqual(saved)
	})
})
