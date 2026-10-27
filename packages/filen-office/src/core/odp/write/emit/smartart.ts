import { refused, type ParaProps, type ShapeNode, type Spacing, type TextBody } from "../../../presentation/model"
import type { OdpEmitFamily } from "../emit"
import { emitOdpShape } from "./shape"

// A diagram in ODF is the shapes it is drawn with, in one draw:g (ODF has no diagrams: the data, layout and style
// parts stay with PresentationML targets only). The frame's laid-out shapes are its `children` (the drawing's shapes
// in the frame's own space, as the SmartArt engine's relayout answers them; whoever writes a diagram to ODF lays it
// out first), written through the shape family as a new group whose child space is the frame's box. A frame that is
// no diagram is the shape family's; a diagram not laid out is refused, never dropped. Paragraph spacing in percent of
// a line, which ODF has no form for, is written in points at the paragraph's largest size (§21.1.2.2.11: a line is
// 1.2 × that size), as the fresh ODP writer writes it.

const MAX_ID = 0x7fff_ffff
const MAX_DEPTH = 128

function maxId(shapes: readonly ShapeNode[], depth = 0): number {
	let highest = 0

	if (depth > MAX_DEPTH) return highest

	for (const shape of shapes) {
		highest = Math.max(highest, shape.id)

		if (shape.children !== undefined) highest = Math.max(highest, maxId(shape.children, depth + 1))
	}

	return highest
}

const DEFAULT_SIZE = 1800

function inPoints(spacing: Spacing | undefined, size: number): Spacing | undefined {
	return spacing === undefined || !("pct" in spacing) ? spacing : { pts: Math.round((spacing.pct / 100_000) * size * 1.2) }
}

function pointSpacing(pPr: ParaProps, size: number): ParaProps {
	if ((pPr.spcBef === undefined || !("pct" in pPr.spcBef)) && (pPr.spcAft === undefined || !("pct" in pPr.spcAft))) return pPr

	const spcBef = inPoints(pPr.spcBef, size)
	const spcAft = inPoints(pPr.spcAft, size)

	return { ...pPr, ...(spcBef === undefined ? {} : { spcBef }), ...(spcAft === undefined ? {} : { spcAft }) }
}

function bodyInPoints(body: TextBody): TextBody {
	const levels = body.lstStyle?.levels.map(level =>
		level === undefined ? undefined : pointSpacing(level, level.defRPr?.sz ?? DEFAULT_SIZE)
	)

	return {
		...body,
		...(body.lstStyle === undefined || levels === undefined ? {} : { lstStyle: { ...body.lstStyle, levels } }),
		paragraphs: body.paragraphs.map(paragraph => {
			let largest = paragraph.endRPr?.sz ?? 0

			for (const run of paragraph.runs) if (run.kind !== "opaque") largest = Math.max(largest, run.rPr.sz ?? 0)

			return { ...paragraph, pPr: pointSpacing(paragraph.pPr, largest > 0 ? largest : DEFAULT_SIZE) }
		})
	}
}

export const emitOdpSmartArt: OdpEmitFamily = {
	emit(request, context) {
		const shape = request.shape

		if (shape === undefined) return refused("failed", "a diagram emit without a shape")
		if (shape.frame?.kind !== "smartart") return emitOdpShape.emit(request, context)

		const xfrm = shape.xfrm
		const children = shape.children

		if (xfrm === undefined || children === undefined || children.length === 0)
			return refused("unsupported", "a diagram not laid out cannot be written as ODF shapes")

		// The members are new shapes of the page: ids above every id it has.
		let next = Math.max(maxId(request.slide.shapes), shape.id)
		const renumber = (members: readonly ShapeNode[], depth: number): ShapeNode[] =>
			members.map(member => {
				next = Math.min(MAX_ID, next + 1)

				const { src: _src, ...own } = member

				return {
					...own,
					id: next,
					...(member.text === undefined ? {} : { text: bodyInPoints(member.text) }),
					...(member.children === undefined || depth >= MAX_DEPTH ? {} : { children: renumber(member.children, depth + 1) })
				}
			})
		const { frame: _frame, src: _src, ...own } = shape
		const group: ShapeNode = {
			...own,
			kind: "grpSp",
			xfrm: { ...xfrm, chX: 0, chY: 0, chCx: xfrm.cx, chCy: xfrm.cy },
			children: renumber(children, 0)
		}

		return emitOdpShape.emit({ ...request, shape: group }, context)
	}
}
