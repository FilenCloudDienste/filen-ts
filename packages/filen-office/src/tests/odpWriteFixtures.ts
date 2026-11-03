import { bytesSource, memorySink, ZipArchive } from "@filen/office/core/opc"
import { openOdp, type OdpParts } from "../core/odp/read/document"
import { saveOdp } from "../core/odp/write/save"
import type { PptxSaveOptions, PptxSaveOutcome } from "../core/pptx/write/types"
import { applyOp, type DeckChanges, type Touch } from "../core/presentation/edit/apply"
import type { DeckOp } from "../core/presentation/edit/ops"
import { slideRef, type Deck, type Refused, type ShapeNode, type SlideNode, type SlideRef } from "../core/presentation/model"
import { odpSourceReading } from "../core/odp/write/session"
import { odpWriteSource } from "../core/odp/write/source"
import { decodeUtf8 } from "../core/xml/index"
import { odpBytes, type OdpFixture } from "./odpFixtures"

// ODP decks for the writer's tests: opened with every page parsed, edited the way the apply families edit the model
// (the slide's revision bumped), saved, and read again.

export interface OpenedOdp {
	readonly bytes: Uint8Array
	readonly deck: Deck
	readonly parts: OdpParts
}

export async function openOdpDeck(bytes: Uint8Array, parse = true): Promise<OpenedOdp> {
	const opened = await openOdp(bytesSource(bytes))

	if (opened.kind !== "opened") throw new Error(`refused: ${opened.reason} ${opened.detail ?? ""}`)
	if (parse) await opened.parts.parseAll()

	return { bytes, deck: opened.deck, parts: opened.parts }
}

// What the writer is told changed: anything, plus the presentation-level touches named.
export function changes(...presentation: Extract<Touch, { kind: "presentation" }>["what"][]): DeckChanges {
	return {
		empty: false,
		parts: new Map([["/content.xml", { change: "changed", shapes: new Map() }]]),
		presentation: new Set(presentation)
	}
}

export async function saveDeck(
	opened: OpenedOdp,
	deckChanges: DeckChanges = changes(),
	options: PptxSaveOptions = {}
): Promise<{ readonly outcome: PptxSaveOutcome; readonly bytes: Uint8Array }> {
	const sink = memorySink()
	const outcome = await saveOdp({ deck: opened.deck, source: { parts: opened.parts }, changes: deckChanges, revision: 1 }, sink, options)

	return { outcome, bytes: outcome.kind === "written" ? sink.bytes() : new Uint8Array(0) }
}

export function slideAt(opened: OpenedOdp, index: number): SlideNode {
	const ref = opened.deck.slides[index]
	const node = ref === undefined ? undefined : opened.deck.nodes.get(ref)

	if (node === undefined) throw new Error(`no slide ${String(index)}`)

	return node
}

// Marks a slide edited, as every apply family does.
export function touched(node: SlideNode): SlideNode {
	node.revision++

	return node
}

export function shapeNamed(node: SlideNode, name: string): ShapeNode {
	const found = find(node.shapes, name)

	if (found === undefined) throw new Error(`no shape ${name}`)

	return found
}

function find(shapes: readonly ShapeNode[], name: string): ShapeNode | undefined {
	for (const shape of shapes) {
		if (shape.name === name) return shape

		const inner = shape.children === undefined ? undefined : find(shape.children, name)

		if (inner !== undefined) return inner
	}

	return undefined
}

export async function entriesOf(bytes: Uint8Array): Promise<Map<string, Uint8Array>> {
	const archive = await ZipArchive.open(bytesSource(bytes))
	const out = new Map<string, Uint8Array>()

	for (const entry of archive.entries) out.set(entry.name, await archive.read(entry))

	return out
}

export function text(bytes: Uint8Array | undefined): string {
	return bytes === undefined ? "" : decodeUtf8(bytes, 0, bytes.length)
}

const AUTOMATIC =
	'<style:style style:name="gr1" style:family="graphic"><style:graphic-properties draw:fill="solid" draw:fill-color="#ff0000" draw:stroke="none"/></style:style>' +
	'<style:style style:name="pr1" style:family="presentation" style:parent-style-name="M-title"><style:graphic-properties draw:fill="none"/></style:style>' +
	'<style:style style:name="P1" style:family="paragraph"><style:paragraph-properties fo:text-align="center"/><style:text-properties fo:font-size="24pt"/></style:style>' +
	'<style:style style:name="T1" style:family="text"><style:text-properties fo:font-weight="bold"/></style:style>' +
	'<style:style style:name="dp1" style:family="drawing-page"><style:drawing-page-properties presentation:background-visible="true"/></style:style>' +
	'<text:list-style style:name="L1"><text:list-level-style-bullet text:level="1" text:bullet-char="●"><style:list-level-properties text:space-before="0.3cm" text:min-label-width="0.6cm"/></text:list-level-style-bullet></text:list-style>'

const STYLES =
	'<style:style style:name="M-title" style:family="presentation"><style:graphic-properties draw:fill="solid" draw:fill-color="#eeeeee"/><style:text-properties fo:font-size="40pt"/></style:style>' +
	'<style:style style:name="M-outline1" style:family="presentation"><style:graphic-properties><text:list-style style:name="M-outline1"><text:list-level-style-bullet text:level="1" text:bullet-char="•"><style:list-level-properties text:space-before="0.5cm" text:min-label-width="0.9cm"/></text:list-level-style-bullet><text:list-level-style-bullet text:level="2" text:bullet-char="–"><style:list-level-properties text:space-before="1.5cm" text:min-label-width="0.9cm"/></text:list-level-style-bullet></text:list-style></style:graphic-properties><style:text-properties fo:font-size="32pt"/></style:style>' +
	'<style:style style:name="M-outline2" style:family="presentation" style:parent-style-name="M-outline1"><style:text-properties fo:font-size="28pt"/></style:style>'

const PAGE_ONE =
	'<draw:page draw:name="Intro" draw:style-name="dp1" draw:master-page-name="M" presentation:presentation-page-layout-name="AL1T0">' +
	'<draw:frame draw:name="Title" presentation:style-name="pr1" presentation:class="title" svg:x="2cm" svg:y="1cm" svg:width="24cm" svg:height="3cm"><draw:text-box><text:p text:style-name="P1">Hello <text:span text:style-name="T1">bold</text:span> world</text:p></draw:text-box></draw:frame>' +
	'<draw:frame draw:name="Body" presentation:style-name="M-outline1" presentation:class="outline" svg:x="2cm" svg:y="5cm" svg:width="24cm" svg:height="13cm"><draw:text-box><text:list><text:list-item><text:p>First</text:p></text:list-item><text:list-item><text:p>Second</text:p><text:list><text:list-item><text:p>Inner</text:p></text:list-item></text:list></text:list-item></text:list></draw:text-box></draw:frame>' +
	'<draw:custom-shape draw:name="Box" draw:style-name="gr1" svg:x="3cm" svg:y="15cm" svg:width="4cm" svg:height="2cm"><svg:title>A box</svg:title><text:p>Box text</text:p><draw:enhanced-geometry svg:viewBox="0 0 21600 21600" draw:type="rectangle" draw:enhanced-path="M 0 0 L 21600 0 21600 21600 0 21600 Z N"/></draw:custom-shape>' +
	'<draw:g draw:name="Group"><draw:rect draw:name="R1" draw:style-name="gr1" svg:x="10cm" svg:y="15cm" svg:width="2cm" svg:height="2cm"/><draw:ellipse draw:name="E1" draw:style-name="gr1" svg:x="13cm" svg:y="15cm" svg:width="2cm" svg:height="2cm"/></draw:g>' +
	'<draw:line draw:name="Line" svg:x1="1cm" svg:y1="19cm" svg:x2="8cm" svg:y2="20cm"><text:p/></draw:line>' +
	'<presentation:notes draw:style-name="dp1"><draw:frame presentation:class="notes" svg:x="2cm" svg:y="14cm" svg:width="17cm" svg:height="10cm"><draw:text-box><text:p>Notes one</text:p></draw:text-box></draw:frame></presentation:notes>' +
	"</draw:page>"

const PAGE_TWO =
	'<draw:page draw:name="Middle" draw:master-page-name="M" presentation:presentation-page-layout-name="AL1T0">' +
	'<draw:frame draw:name="Title2" presentation:class="title" svg:x="2cm" svg:y="1cm" svg:width="24cm" svg:height="3cm"><draw:text-box><text:p>Second page <text:a xlink:type="simple" xlink:href="#End">to the end</text:a></text:p></draw:text-box></draw:frame>' +
	'<draw:a xlink:type="simple" xlink:href="#End"><draw:custom-shape draw:name="Jump" draw:style-name="gr1" svg:x="3cm" svg:y="6cm" svg:width="4cm" svg:height="2cm" xml:id="id1" draw:id="id1"><draw:enhanced-geometry svg:viewBox="0 0 21600 21600" draw:type="ellipse"/></draw:custom-shape></draw:a>' +
	"</draw:page>"

const PAGE_THREE =
	'<draw:page draw:name="End" draw:master-page-name="M">' +
	'<draw:frame draw:name="Title3" presentation:class="title" svg:x="2cm" svg:y="1cm" svg:width="24cm" svg:height="3cm"><draw:text-box><text:p>The end</text:p></draw:text-box></draw:frame>' +
	"</draw:page>"

export const ODP_DECK: OdpFixture = {
	automatic: AUTOMATIC,
	styles: STYLES,
	body:
		'<presentation:footer-decl presentation:name="ftr1">Footer text</presentation:footer-decl>' +
		PAGE_ONE +
		PAGE_TWO +
		PAGE_THREE +
		'<presentation:settings presentation:start-page="Middle"><presentation:show presentation:name="Short" presentation:pages="Intro,End"/></presentation:settings>'
}

export function odpDeck(): Uint8Array {
	return odpBytes(ODP_DECK)
}

// The slide and shape families over an opened deck, as the edit session applies ops (ODP source reading).
export function odpApplier(opened: OpenedOdp): (op: DeckOp) => Refused | undefined {
	let next = 0x4000_0000
	const context = odpSourceReading(opened.deck, odpWriteSource(opened.parts), { next: () => slideRef(next++) })

	return op => {
		const result = applyOp(opened.deck, op, context)

		return result.kind === "refused" ? result : undefined
	}
}

export interface OdpShapeAndSlideEditsReport {
	readonly moved?: { readonly slide: SlideRef; readonly name: string }
	readonly hidden?: SlideRef
	readonly duplicated?: SlideRef
	readonly added?: SlideRef
	readonly deleted?: SlideRef
	readonly refusals: string[]
}

function firstEditable(shapes: readonly ShapeNode[]): ShapeNode | undefined {
	return shapes.find(
		shape =>
			shape.kind === "sp" &&
			shape.synthetic !== true &&
			shape.lock === undefined &&
			shape.xfrm !== undefined &&
			shape.src !== undefined &&
			shape.ph === undefined &&
			shape.xfrm.cx > 0
	)
}

// The shape and slide edit set (no text edits) through the families: move, resize and turn a shape and fill it; hide a slide; put a
// slide on another layout of its master; duplicate a slide; add a slide on the first slide's layout; delete a slide
// (a jump target when there is one); move the first slide last. Each op the families refuse is reported, not hidden.
export function applyOdpShapeAndSlideEdits(opened: OpenedOdp): OdpShapeAndSlideEditsReport {
	const deck = opened.deck
	const apply = odpApplier(opened)
	const refusals: string[] = []
	const report: { -readonly [K in keyof OdpShapeAndSlideEditsReport]: OdpShapeAndSlideEditsReport[K] } = { refusals }
	const run = (op: DeckOp): boolean => {
		const refusal = apply(op)

		if (refusal !== undefined) refusals.push(`${op.family}.${op.kind}: ${refusal.reason} ${refusal.detail ?? ""}`)

		return refusal === undefined
	}

	for (const ref of [...deck.slides]) {
		const node = deck.nodes.get(ref)
		const shape = node === undefined ? undefined : firstEditable(node.shapes)

		if (node === undefined || shape?.xfrm === undefined) continue

		const target = { slide: ref, id: shape.id }

		run({
			family: "shape",
			kind: "setXfrm",
			target,
			xfrm: { ...shape.xfrm, x: shape.xfrm.x + 12_700, y: shape.xfrm.y + 12_700, cx: Math.round(shape.xfrm.cx * 1.1), rot: 600_000 }
		})
		run({ family: "shape", kind: "setProps", target, props: { fill: { kind: "solid", color: { kind: "srgb", rgb: "4472C4" } } } })
		report.moved = { slide: ref, name: shape.name }

		break
	}

	const first = deck.slides[0]
	const firstNode = first === undefined ? undefined : deck.nodes.get(first)

	if (first !== undefined && run({ family: "slide", kind: "hide", slides: [first], hidden: !(firstNode?.hidden ?? false) }))
		report.hidden = first

	if (firstNode?.parent !== undefined) {
		const current = deck.nodes.get(firstNode.parent)
		const other = deck.layouts
			.map(ref => deck.nodes.get(ref))
			.find(layout => layout !== undefined && layout.ref !== current?.ref && layout.parent === current?.parent)

		if (other !== undefined) run({ family: "slide", kind: "setLayout", slide: firstNode.ref, layout: other.ref })
	}

	const source = deck.slides[1] ?? first

	if (source !== undefined) {
		const before = new Set(deck.slides)

		const made = run({ family: "slide", kind: "duplicate", slide: source }) ? deck.slides.find(ref => !before.has(ref)) : undefined

		if (made !== undefined) report.duplicated = made
	}

	if (firstNode?.parent !== undefined) {
		const before = new Set(deck.slides)

		const made = run({ family: "slide", kind: "add", layout: firstNode.parent, at: deck.slides.length })
			? deck.slides.find(ref => !before.has(ref))
			: undefined

		if (made !== undefined) report.added = made
	}

	const targets = new Set<SlideRef>()

	for (const node of deck.nodes.values()) {
		const visit = (shapes: readonly ShapeNode[]): void => {
			for (const shape of shapes) {
				if (shape.actions?.click?.kind === "slide") targets.add(shape.actions.click.slide)
				if (shape.children !== undefined) visit(shape.children)
			}
		}

		visit(node.shapes)
	}

	const deletable = deck.slides.filter((ref, index) => index > 1 && ref < 0x4000_0000 && ref !== report.moved?.slide)
	const victim = deletable.find(ref => targets.has(ref)) ?? deletable.at(-1)

	if (victim !== undefined && deck.slides.length > 2 && run({ family: "slide", kind: "delete", slides: [victim] }))
		report.deleted = victim

	const head = deck.slides[0]

	if (head !== undefined && deck.slides.length > 1) run({ family: "slide", kind: "move", slides: [head], to: deck.slides.length - 1 })

	return report
}

// Text edits as the text family makes them (a whole new body for one shape): type at the start of a body, bold the
// second half of its first run, centre its first paragraph, add a paragraph like its last one. On the first shape of
// each of the first `slides` slides with a body that has text; the shapes edited.
export function applyOdpTextEdits(opened: OpenedOdp, slides = 3): ShapeNode[] {
	const edited: ShapeNode[] = []

	for (const ref of opened.deck.slides.slice(0, slides)) {
		const node = opened.deck.nodes.get(ref)
		const shape = node?.shapes.find(
			candidate =>
				candidate.synthetic !== true &&
				candidate.lock === undefined &&
				candidate.text?.paragraphs.some(paragraph => paragraph.runs.some(run => run.kind === "r" && run.text.length > 1)) === true
		)

		if (node === undefined || shape?.text === undefined) continue

		const paragraphs = shape.text.paragraphs.map(paragraph => ({ ...paragraph, runs: [...paragraph.runs] }))
		const index = paragraphs.findIndex(paragraph => paragraph.runs.some(run => run.kind === "r" && run.text.length > 1))
		const paragraph = paragraphs[index]

		if (paragraph === undefined) continue

		const at = paragraph.runs.findIndex(run => run.kind === "r" && run.text.length > 1)
		const run = paragraph.runs[at]

		if (run?.kind !== "r") continue

		const typed = `X ${run.text}`
		const half = Math.ceil(typed.length / 2)

		paragraph.runs.splice(
			at,
			1,
			{ kind: "r", text: typed.slice(0, half), rPr: run.rPr },
			{ kind: "r", text: typed.slice(half), rPr: { ...run.rPr, b: true } }
		)
		paragraph.pPr = { ...paragraph.pPr, algn: "ctr" }

		const last = paragraphs[paragraphs.length - 1] as (typeof paragraphs)[number]
		const lastRun = last.runs.find(item => item.kind === "r")

		paragraphs.push({
			pPr: last.pPr,
			runs: [{ kind: "r", text: "Added", rPr: lastRun?.kind === "r" ? lastRun.rPr : (last.endRPr ?? {}) }],
			...(last.endRPr === undefined ? {} : { endRPr: last.endRPr })
		})
		shape.text = { ...shape.text, paragraphs }
		node.revision++
		edited.push(shape)
	}

	return edited
}
