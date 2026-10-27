import { D, drawingReader, type DrawingReader } from "../drawingml/reader"
import type { Spacing } from "../presentation/model"
import type { XmlDocument } from "../xml/index"

// The diagram data model (ECMA-376 §21.4.3): points joined by parOf connections into a tree under the doc
// point, with each node's parent and sibling transitions beside it, plus the presentation points the last
// layout wrote. Office allows one parent per point (MS-OI29500 §2.1.1623a), so the tree is a tree.

export type PointType = "doc" | "node" | "asst" | "parTrans" | "sibTrans" | "pres"

export interface SmartArtBudgets {
	readonly maxPoints: number
	readonly maxLayoutNodes: number
	readonly maxForEachDepth: number
	readonly maxConstraintPasses: number
	readonly maxRuleSteps: number
	// Expansion steps (bodies applied, points an iteration or a test visits), whether or not they make layout nodes.
	readonly maxExpansionWork?: number
}

export const DEFAULT_SMARTART_BUDGETS: SmartArtBudgets = {
	maxPoints: 5000,
	maxLayoutNodes: 100_000,
	maxForEachDepth: 32,
	maxConstraintPasses: 64,
	maxRuleSteps: 200,
	maxExpansionWork: 2_000_000
}

export type SmartArtRefusal = "tooLarge" | "tooDeep" | "malformed"

export class SmartArtError extends Error {
	readonly reason: SmartArtRefusal

	constructor(reason: SmartArtRefusal, message: string) {
		super(message)
		this.name = "SmartArtError"
		this.reason = reason
	}
}

// The prSet attributes layout reads (§21.4.3.4); custom sizes and offsets are the user's own edits.
export interface PresProps {
	readonly presName?: string | undefined
	readonly presAssocID?: string | undefined
	readonly presStyleLbl?: string | undefined
	readonly presStyleIdx?: number | undefined
	readonly presStyleCnt?: number | undefined
	readonly custScaleX?: number | undefined
	readonly custScaleY?: number | undefined
	readonly custLinFactNeighborX?: number | undefined
	readonly custLinFactNeighborY?: number | undefined
	readonly custT?: boolean | undefined
	// presLayoutVars written on a presentation point: they override the layout node's varLst.
	readonly vars?: ReadonlyMap<string, string> | undefined
}

// What text measurement needs of a run beyond its characters (§21.1.2.3.9 rPr): its weight, slant and face, and
// its own size (kept by custom text only).
export interface RichRun {
	readonly text: string
	readonly b?: boolean | undefined
	readonly i?: boolean | undefined
	// Hundredths of a point.
	readonly sz?: number | undefined
	readonly latin?: string | undefined
}

// A paragraph's runs and the spacing its own pPr sets (a:lnSpc/spcBef/spcAft as ParaProps carry them: spcPct in
// thousandths of a percent, spcPts in hundredths of a point).
export interface RichParagraph {
	readonly runs: readonly RichRun[]
	readonly lnSpc?: Spacing | undefined
	readonly spcBef?: Spacing | undefined
	readonly spcAft?: Spacing | undefined
}

export interface DataPoint {
	readonly id: string
	readonly type: PointType
	// One string per paragraph of dgm:t.
	readonly paragraphs: readonly string[]
	// The same paragraphs with their run and spacing properties, only when some run or paragraph sets one.
	readonly rich?: readonly RichParagraph[] | undefined
	readonly props: PresProps
	parent: DataPoint | undefined
	// The ordered axis of this point's children: per parOf connection in srcOrd order, its parent
	// transition, the child, then its sibling transition.
	readonly children: DataPoint[]
	depth: number
}

export interface DataModel {
	readonly root: DataPoint
	readonly points: ReadonlyMap<string, DataPoint>
	// Presentation points by presName then presAssocID, in document order.
	readonly pres: readonly DataPoint[]
}

const POINT_TYPES: ReadonlySet<string> = new Set(["doc", "node", "asst", "parTrans", "sibTrans", "pres"])

function readPresProps(reader: DrawingReader, prSet: number): PresProps {
	if (prSet < 0) return {}

	const document = reader.document
	const vars = new Map<string, string>()
	const lv = reader.child(prSet, D.Dgm, "presLayoutVars")

	for (let v = lv < 0 ? -1 : document.firstChildElement(lv); v >= 0; v = document.nextSiblingElement(v)) {
		vars.set(document.localName(v), reader.attr(v, "val") ?? "")
	}

	const int = (name: string): number | undefined => {
		const value = reader.number(prSet, name, Number.NaN)

		return Number.isNaN(value) ? undefined : value
	}

	return {
		presName: reader.attr(prSet, "presName"),
		presAssocID: reader.attr(prSet, "presAssocID"),
		presStyleLbl: reader.attr(prSet, "presStyleLbl"),
		presStyleIdx: int("presStyleIdx"),
		presStyleCnt: int("presStyleCnt"),
		custScaleX: int("custScaleX"),
		custScaleY: int("custScaleY"),
		custLinFactNeighborX: int("custLinFactNeighborX"),
		custLinFactNeighborY: int("custLinFactNeighborY"),
		custT: reader.bool(prSet, "custT", false),
		vars: vars.size > 0 ? vars : undefined
	}
}

function spacingOf(reader: DrawingReader, node: number): Spacing | undefined {
	if (node < 0) return undefined

	const pct = reader.child(node, D.A, "spcPct")

	if (pct >= 0) {
		const value = reader.fraction(pct, "val", Number.NaN)

		return Number.isFinite(value) ? { pct: Math.max(0, value * 100000) } : undefined
	}

	const pts = reader.number(reader.child(node, D.A, "spcPts"), "val", Number.NaN)

	return Number.isFinite(pts) ? { pts: Math.max(0, pts) } : undefined
}

function richRun(reader: DrawingReader, rPr: number, text: string): RichRun {
	if (rPr < 0) return { text }

	const has = (name: string): boolean => reader.attr(rPr, name) !== undefined
	const sz = reader.number(rPr, "sz", Number.NaN)
	const latin = reader.attr(reader.child(rPr, D.A, "latin"), "typeface")

	return {
		text,
		...(has("b") ? { b: reader.bool(rPr, "b", false) } : {}),
		...(has("i") ? { i: reader.bool(rPr, "i", false) } : {}),
		...(Number.isFinite(sz) && sz > 0 ? { sz } : {}),
		...(latin === undefined || latin === "" ? {} : { latin })
	}
}

function styled(paragraph: RichParagraph): boolean {
	if (paragraph.lnSpc !== undefined || paragraph.spcBef !== undefined || paragraph.spcAft !== undefined) return true

	return paragraph.runs.some(run => run.b !== undefined || run.i !== undefined || run.sz !== undefined || run.latin !== undefined)
}

// dgm:t's paragraphs as text, and with their properties when any is set.
function readParagraphs(reader: DrawingReader, t: number): { paragraphs: string[]; rich: RichParagraph[] | undefined } {
	if (t < 0) return { paragraphs: [], rich: undefined }

	const paragraphs: string[] = []
	const rich: RichParagraph[] = []
	const document = reader.document
	let anyStyle = false

	for (const p of reader.children(t, D.A, "p")) {
		let text = ""
		const runs: RichRun[] = []

		for (let r = document.firstChildElement(p); r >= 0; r = document.nextSiblingElement(r)) {
			if (reader.is(r, D.A, "r") || reader.is(r, D.A, "fld")) {
				const value = reader.text(reader.child(r, D.A, "t"))

				text += value
				runs.push(richRun(reader, reader.child(r, D.A, "rPr"), value))
			} else if (reader.is(r, D.A, "br")) {
				text += "\n"
				runs.push({ text: "\n" })
			}
		}

		const pPr = reader.child(p, D.A, "pPr")
		const paragraph: RichParagraph =
			pPr < 0
				? { runs }
				: {
						runs,
						lnSpc: spacingOf(reader, reader.child(pPr, D.A, "lnSpc")),
						spcBef: spacingOf(reader, reader.child(pPr, D.A, "spcBef")),
						spcAft: spacingOf(reader, reader.child(pPr, D.A, "spcAft"))
					}

		anyStyle ||= styled(paragraph)
		paragraphs.push(text)
		rich.push(paragraph)
	}

	return { paragraphs, rich: anyStyle ? rich : undefined }
}

interface Cxn {
	readonly src: string
	readonly dest: string
	readonly srcOrd: number
	readonly parTrans?: string | undefined
	readonly sibTrans?: string | undefined
}

// Reads dgm:dataModel. Refuses (SmartArtError) past the point budget or without a doc point.
export function parseDataModel(document: XmlDocument, budgets: SmartArtBudgets = DEFAULT_SMARTART_BUDGETS): DataModel {
	const reader = drawingReader(document)
	const model = document.documentElement()

	if (!reader.is(model, D.Dgm, "dataModel")) throw new SmartArtError("malformed", "not a dgm:dataModel")

	const points = new Map<string, DataPoint>()
	const pres: DataPoint[] = []
	let root: DataPoint | undefined

	for (const pt of reader.children(reader.child(model, D.Dgm, "ptLst"), D.Dgm, "pt")) {
		if (points.size >= budgets.maxPoints) throw new SmartArtError("tooLarge", `more than ${budgets.maxPoints} points`)

		const id = reader.attr(pt, "modelId")

		if (id === undefined || points.has(id)) continue

		const typeText = reader.attr(pt, "type") ?? "node"
		const type = (POINT_TYPES.has(typeText) ? typeText : "node") as PointType
		const text = readParagraphs(reader, reader.child(pt, D.Dgm, "t"))
		const point: DataPoint = {
			id,
			type,
			paragraphs: text.paragraphs,
			...(text.rich === undefined ? {} : { rich: text.rich }),
			props: readPresProps(reader, reader.child(pt, D.Dgm, "prSet")),
			parent: undefined,
			children: [],
			depth: 0
		}

		points.set(id, point)

		if (type === "pres") pres.push(point)
		else if (type === "doc" && root === undefined) root = point
	}

	if (root === undefined) throw new SmartArtError("malformed", "no doc point")

	const cxns: Cxn[] = []

	for (const cxn of reader.children(reader.child(model, D.Dgm, "cxnLst"), D.Dgm, "cxn")) {
		const type = reader.attr(cxn, "type") ?? "parOf"

		if (type !== "parOf") continue

		const src = reader.attr(cxn, "srcId")
		const dest = reader.attr(cxn, "destId")

		if (src === undefined || dest === undefined) continue

		cxns.push({
			src,
			dest,
			srcOrd: reader.number(cxn, "srcOrd", 0),
			parTrans: reader.attr(cxn, "parTransId"),
			sibTrans: reader.attr(cxn, "sibTransId")
		})
	}

	cxns.sort((a, b) => a.srcOrd - b.srcOrd)

	// Whether `point` may hang under `parent`: one parent per point, never the root, never the parent itself or one
	// of its ancestors (a transition id naming the doc point or an ancestor would make the tree its own descendant).
	// The walk up is bounded by the point count, so a hostile chain cannot make it run on.
	const attachable = (point: DataPoint, parent: DataPoint): boolean => {
		if (point === root || point.parent !== undefined) return false

		let ancestor: DataPoint | undefined = parent

		for (let steps = 0; ancestor !== undefined && steps <= points.size; steps++) {
			if (ancestor === point) return false

			ancestor = ancestor.parent
		}

		return ancestor === undefined
	}

	for (const cxn of cxns) {
		const parent = points.get(cxn.src)
		const child = points.get(cxn.dest)

		if (parent === undefined || child === undefined || !attachable(child, parent)) continue

		child.parent = parent

		const parTrans = cxn.parTrans === undefined ? undefined : points.get(cxn.parTrans)
		const sibTrans = cxn.sibTrans === undefined ? undefined : points.get(cxn.sibTrans)

		if (parTrans !== undefined && parTrans !== child && attachable(parTrans, parent)) {
			parTrans.parent = parent
			parent.children.push(parTrans)
		}

		parent.children.push(child)

		if (sibTrans !== undefined && sibTrans !== child && attachable(sibTrans, parent)) {
			sibTrans.parent = parent
			parent.children.push(sibTrans)
		}
	}

	// Depths from the root; every point is visited at most once (the links above keep the tree a tree).
	const stack: DataPoint[] = [root]

	for (let visited = 0; stack.length > 0; visited++) {
		if (visited > points.size) throw new SmartArtError("malformed", "the data model's connections do not form a tree")

		const point = stack.pop() as DataPoint

		for (const child of point.children) {
			child.depth = point.depth + 1
			stack.push(child)
		}
	}

	return { root, points, pres }
}

export function pointText(point: DataPoint): string {
	return point.paragraphs.join("\n")
}
