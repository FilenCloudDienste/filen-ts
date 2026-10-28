import type { FreshForeignParts } from "../../pptx/write/fresh"
import type { Action, Deck, Paragraph, Run, RunProps, ShapeNode, SlideNode, TextBody } from "../../presentation/model"
import type { ConversionReport } from "./report"

// An ODF deck as PresentationML holds it: what the ODF reader modelled is written by the fresh PresentationML writer
// from the model; this adapter turns what PresentationML has no form for into its nearest form, each counted:
// an embedded object (draw:object that is no chart) is its replacement picture; actions PresentationML cannot carry
// (scripts, programs: inert as read) are left out; content the reader kept as ODF source (an unknown run, a shape it
// did not model) becomes its text or is left out. Pictures and media are copied from the package by bytes.

// ST_SlideLayoutType (ECMA-376 Part 1 §19.7.15); an ODF page layout's own name is none of them.
const LAYOUT_TYPES: ReadonlySet<string> = new Set([
	"title",
	"tx",
	"twoColTx",
	"tbl",
	"txAndChart",
	"chartAndTx",
	"dgm",
	"chart",
	"txAndClipArt",
	"clipArtAndTx",
	"titleOnly",
	"blank",
	"txAndObj",
	"objAndTx",
	"objOnly",
	"obj",
	"txAndMedia",
	"mediaAndTx",
	"objOverTx",
	"txOverObj",
	"txAndTwoObj",
	"twoObjAndTx",
	"twoObjOverTx",
	"fourObj",
	"vertTx",
	"clipArtAndVertTx",
	"vertTitleAndTx",
	"vertTitleAndTxOverChart",
	"twoObj",
	"objAndTwoObj",
	"twoObjAndObj",
	"cust",
	"secHead",
	"twoTxTwoObj",
	"objTx",
	"picTx"
])
// ST_TextBulletSizePercent (§20.1.10.62): 25% to 400%.
const MIN_BULLET_PCT = 25_000
const MAX_BULLET_PCT = 400_000
// The field types PresentationML updates (§21.1.2.2.4 a:fld): the slide number and the date and time formats.
const PRESENTATION_FIELDS = /^(?:slidenum|datetime(?:[1-9]|1[0-3])?)$/u
const GUID = /^\{[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}\}$/u

// A field's id as a:fld requires it (a GUID, §20.1.2.2.4): an ODF field has none, so one is derived from what the
// reader named it (the same field gets the same id on every conversion).
export function fieldGuid(id: string): string {
	if (GUID.test(id)) return id

	let hex = ""

	for (let round = 0; hex.length < 32; round++) {
		let hash = 0x811c9dc5 ^ round

		for (let at = 0; at < id.length; at++) hash = Math.imul(hash ^ id.charCodeAt(at), 0x01000193)

		hex += (hash >>> 0).toString(16).padStart(8, "0")
	}

	const digits = hex.toUpperCase()

	return `{${digits.slice(0, 8)}-${digits.slice(8, 12)}-4${digits.slice(13, 16)}-8${digits.slice(17, 20)}-${digits.slice(20, 32)}}`
}

const PRESENTATION_IMAGES = /^image\/(?:png|jpeg|gif|bmp|tiff|svg\+xml|x-emf|x-wmf)$/u
const MAX_DEPTH = 128

// The slide a node is (1-based), for the report; none for masters, layouts and notes.
function slideNumbers(deck: Deck): Map<string, number> {
	const numbers = new Map<string, number>()

	deck.slides.forEach((ref, index) => numbers.set(String(ref), index + 1))

	return numbers
}

function carried(action: Action | undefined): boolean {
	return action === undefined || action.kind !== "refused"
}

class Adapter {
	private readonly report: ConversionReport
	private readonly parts: FreshForeignParts | undefined
	private slides: readonly number[] = []

	constructor(report: ConversionReport, parts: FreshForeignParts | undefined) {
		this.report = report
		this.parts = parts
	}

	at(slide: number | undefined): void {
		this.slides = slide === undefined ? [] : [slide]
	}

	private note(kind: Parameters<ConversionReport["note"]>[0]): void {
		this.report.note(kind, 1, this.slides)
	}

	private runProps(props: RunProps): RunProps {
		if (carried(props.hlinkClick) && carried(props.hlinkMouseOver)) return props

		const { hlinkClick, hlinkMouseOver, ...rest } = props

		this.note("action")

		return {
			...rest,
			...(carried(hlinkClick) && hlinkClick !== undefined ? { hlinkClick } : {}),
			...(carried(hlinkMouseOver) && hlinkMouseOver !== undefined ? { hlinkMouseOver } : {})
		}
	}

	private run(run: Run): Run {
		if (run.kind === "opaque") {
			this.note("text")

			return { kind: "r", text: run.text, rPr: {} }
		}

		const rPr = this.runProps(run.rPr)

		if (run.kind === "fld" && !PRESENTATION_FIELDS.test(run.type)) {
			// A field PresentationML has no type for (a page count, the file name, the author): the text it shows.
			this.note("field")

			return { kind: "r", text: run.text, rPr }
		}

		if (run.kind === "fld" && !GUID.test(run.id)) return { ...run, id: fieldGuid(run.id), rPr }

		return rPr === run.rPr ? run : { ...run, rPr }
	}

	private paragraph(paragraph: Paragraph): Paragraph {
		const runs = paragraph.runs.map(run => this.run(run))
		const endRPr = paragraph.endRPr === undefined ? undefined : this.runProps(paragraph.endRPr)
		const size = paragraph.pPr.buSz
		const pct = size !== undefined && size !== "text" && "pct" in size ? size.pct : undefined
		const pPr =
			pct === undefined || (pct >= MIN_BULLET_PCT && pct <= MAX_BULLET_PCT)
				? paragraph.pPr
				: { ...paragraph.pPr, buSz: { pct: Math.min(MAX_BULLET_PCT, Math.max(MIN_BULLET_PCT, pct)) } }

		if (pPr !== paragraph.pPr) this.note("text")

		return runs.every((run, index) => run === paragraph.runs[index]) && endRPr === paragraph.endRPr && pPr === paragraph.pPr
			? paragraph
			: { ...paragraph, pPr, runs, ...(endRPr === undefined ? {} : { endRPr }) }
	}

	private text(body: TextBody): TextBody {
		const paragraphs = body.paragraphs.map(paragraph => this.paragraph(paragraph))

		return paragraphs.every((paragraph, index) => paragraph === body.paragraphs[index]) ? body : { ...body, paragraphs }
	}

	// A picture the package holds in a form PresentationML shows.
	private showable(part: string | undefined): boolean {
		return part !== undefined && this.parts?.has(part) === true && PRESENTATION_IMAGES.test(this.parts.contentType(part) ?? "")
	}

	shapes(shapes: readonly ShapeNode[], depth = 0): ShapeNode[] {
		const out: ShapeNode[] = []

		for (const shape of shapes) {
			const adapted = this.shape(shape, depth)

			if (adapted !== undefined) out.push(adapted)
		}

		return out
	}

	private shape(shape: ShapeNode, depth: number): ShapeNode | undefined {
		if (shape.kind === "opaque") {
			this.note("shape")

			return undefined
		}

		if (shape.kind === "ink") {
			this.note("ink")

			return undefined
		}

		if (shape.kind === "frame" && shape.frame?.kind === "ole") {
			this.note("oleObject")

			const preview = shape.frame.preview

			if (!this.showable(preview) || preview === undefined) return undefined

			const { frame: _frame, children: _children, ...own } = shape

			return { ...own, kind: "pic", props: { fill: { kind: "picture", part: preview } } }
		}

		if (shape.kind === "frame" && shape.frame?.kind === "unknown") {
			this.note("shape")

			return undefined
		}

		if (shape.kind === "pic") {
			const fill = shape.props?.fill

			if (fill !== undefined && fill !== "none" && fill.kind === "picture" && !this.showable(fill.part)) {
				this.note("picture")

				return undefined
			}
		}

		let next = shape

		if (!carried(shape.actions?.click) || !carried(shape.actions?.hover)) {
			const { actions, ...rest } = shape
			const click = carried(actions?.click) ? actions?.click : undefined
			const hover = carried(actions?.hover) ? actions?.hover : undefined

			this.note("action")
			next = {
				...rest,
				...(click === undefined && hover === undefined
					? {}
					: { actions: { ...(click === undefined ? {} : { click }), ...(hover === undefined ? {} : { hover }) } })
			}
		}

		if (next.text !== undefined) {
			const text = this.text(next.text)

			if (text !== next.text) next = { ...next, text }
		}

		if (next.children !== undefined && depth < MAX_DEPTH) {
			const children = this.shapes(next.children, depth + 1)

			if (children.length !== next.children.length || children.some((child, index) => child !== next.children?.[index]))
				next = { ...next, children }
		}

		return next
	}
}

// Each node as the fresh PresentationML writer writes it from an ODF deck, its losses noted on `report`.
export function odpToPptxAdapter(deck: Deck, report: ConversionReport, parts: FreshForeignParts): (node: SlideNode) => SlideNode {
	const adapter = new Adapter(report, parts)
	const numbers = slideNumbers(deck)

	return node => {
		adapter.at(node.kind === "slide" ? numbers.get(String(node.ref)) : undefined)

		const shapes = adapter.shapes(node.shapes)
		const same = shapes.length === node.shapes.length && shapes.every((shape, index) => shape === node.shapes[index])
		const layoutType = node.layoutType === undefined || LAYOUT_TYPES.has(node.layoutType) ? node.layoutType : undefined

		if (same && layoutType === node.layoutType) return node

		const { layoutType: _layoutType, ...rest } = node

		return { ...rest, shapes, ...(layoutType === undefined ? {} : { layoutType }) }
	}
}
