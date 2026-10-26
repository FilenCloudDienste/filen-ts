import { D, drawingReader, type DrawingReader } from "../drawingml/reader"
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
}

export const DEFAULT_SMARTART_BUDGETS: SmartArtBudgets = {
	maxPoints: 5000,
	maxLayoutNodes: 100_000,
	maxForEachDepth: 32,
	maxConstraintPasses: 64,
	maxRuleSteps: 200
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

export interface DataPoint {
	readonly id: string
	readonly type: PointType
	// One string per paragraph of dgm:t.
	readonly paragraphs: readonly string[]
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

function readParagraphs(reader: DrawingReader, t: number): string[] {
	if (t < 0) return []

	const out: string[] = []

	for (const p of reader.children(t, D.A, "p")) {
		let text = ""
		const document = reader.document

		for (let r = document.firstChildElement(p); r >= 0; r = document.nextSiblingElement(r)) {
			if (reader.is(r, D.A, "r") || reader.is(r, D.A, "fld")) text += reader.text(reader.child(r, D.A, "t"))
			else if (reader.is(r, D.A, "br")) text += "\n"
		}

		out.push(text)
	}

	return out
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
		const point: DataPoint = {
			id,
			type,
			paragraphs: readParagraphs(reader, reader.child(pt, D.Dgm, "t")),
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

	for (const cxn of cxns) {
		const parent = points.get(cxn.src)
		const child = points.get(cxn.dest)

		// One parent per point; a cycle back to an ancestor is dropped from the tree, never followed.
		if (parent === undefined || child === undefined || child.parent !== undefined || child === root) continue

		let ancestor: DataPoint | undefined = parent

		while (ancestor !== undefined && ancestor !== child) ancestor = ancestor.parent

		if (ancestor === child) continue

		child.parent = parent

		const parTrans = cxn.parTrans === undefined ? undefined : points.get(cxn.parTrans)
		const sibTrans = cxn.sibTrans === undefined ? undefined : points.get(cxn.sibTrans)

		if (parTrans !== undefined && parTrans.parent === undefined) {
			parTrans.parent = parent
			parent.children.push(parTrans)
		}

		parent.children.push(child)

		if (sibTrans !== undefined && sibTrans.parent === undefined) {
			sibTrans.parent = parent
			parent.children.push(sibTrans)
		}
	}

	const stack: DataPoint[] = [root]

	while (stack.length > 0) {
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
