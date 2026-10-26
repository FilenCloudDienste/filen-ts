import { bytesSource } from "../core/opc/index"
import { openPptxCapability, pptxParts } from "../dom/presentation/engine/open/pptx"
import { SERVICES, type CallContext, type EditCapability, type EngineSession } from "../dom/presentation/engine"
import { createEditCapability, type EditOptions } from "../dom/presentation/engine/edit"
import type { CommandResult, PresentationEvent } from "../dom/presentation/protocol"
import type { EmitFunction } from "../core/presentation/edit/proof"
import { refused, slideRef, type ShapeNode, type SlideNode } from "../core/presentation/model"
import type { DeckOp } from "../core/presentation/edit/ops"
import { buildPptx, body, para, sp, xfrm, type FixtureOptions } from "./pptxFixtures"

// In-thread edit sessions for the edit capability's tests: a deck opened by the pptx opener into an EngineSession
// (no worker, no scheduler), with the edit capability over it.

// An emitter that writes every source shape as its own source span: proof gate 1 passes for all of them.
export const SOURCE_EMITTER: EmitFunction = (_family, request) =>
	request.shape?.src === undefined
		? refused("notImplemented", "no source")
		: { kind: "markup", pieces: [{ hole: request.shape.src.node }] }

// An emitter that drops everything inside the element: every proof fails.
export const BROKEN_EMITTER: EmitFunction = (_family, request) =>
	request.shape === undefined
		? refused("notImplemented", "slide")
		: { kind: "markup", pieces: ['<p:sp xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"/>'] }

export interface EditHarness {
	readonly session: EngineSession
	readonly context: CallContext
	readonly events: PresentationEvent[]
	readonly edit: EditCapability
	command(op: DeckOp): Promise<CommandResult>
	undo(): Promise<CommandResult>
	redo(): Promise<CommandResult>
	slide(index: number): Promise<SlideNode>
	close(): void
}

export async function editHarness(bytes: Uint8Array, options: EditOptions = { emit: SOURCE_EMITTER }): Promise<EditHarness> {
	const outcome = await openPptxCapability.open({
		source: bytesSource(bytes),
		sourceKind: "bytes",
		options: { format: "pptx", fileName: "deck.pptx" }
	})

	if (outcome.kind !== "opened") throw new Error(`open: ${outcome.kind}`)

	const events: PresentationEvent[] = []
	const closers: (() => void)[] = []
	const session: EngineSession = {
		s: 1,
		deck: outcome.deck,
		package: outcome.package,
		options: { format: "pptx", fileName: "deck.pptx" },
		services: SERVICES,
		rangeSource: undefined,
		schedule: () => undefined,
		emit: event => events.push(event),
		onClose: listener => closers.push(listener)
	}
	const context: CallContext = {
		session,
		signal: { aborted: false, onAbort: () => undefined },
		lane: "priority",
		slicing: { pause: () => Promise.resolve(), sliceMs: 8, now: () => Date.now() }
	}
	const edit = createEditCapability(options)

	return {
		session,
		context,
		events,
		edit,
		command: op => edit.command(context, op),
		undo: () => edit.undo(context),
		redo: () => edit.redo(context),
		slide: async index => {
			const ref = session.deck.slides[index]

			if (ref === undefined) throw new Error(`no slide ${String(index)}`)

			return (pptxParts(session.deck) ?? (undefined as never)).slide(ref)
		},
		close: () => {
			for (const closer of closers) closer()
		}
	}
}

export const P14 = 'xmlns:p14="http://schemas.microsoft.com/office/powerpoint/2010/main"'
export const SECTION_EXT = "{521415D9-36F7-43E2-AB2F-B90AF26B5E84}"

// Four slides: shapes with boxes, a group, a picture-free text box, a slide jump from slide 1 to slide 3, two
// sections and a custom show.
export function editDeckOptions(): FixtureOptions {
	const shapes =
		sp(2, "Title 1", 'type="title"', "", body(para("Title"))) +
		sp(
			3,
			"Box A",
			undefined,
			`${xfrm(100, 100, 1000, 500)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="FF0000"/></a:solidFill>`
		) +
		sp(4, "Box B", undefined, `${xfrm(2000, 300, 800, 400)}<a:prstGeom prst="ellipse"><a:avLst/></a:prstGeom>`, body(para("B"))) +
		sp(5, "Box C", undefined, `${xfrm(4000, 600, 600, 600)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>`) +
		'<p:grpSp><p:nvGrpSpPr><p:cNvPr id="6" name="Group 5"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="5000" y="5000"/><a:ext cx="2000" cy="1000"/><a:chOff x="0" y="0"/><a:chExt cx="1000" cy="500"/></a:xfrm></p:grpSpPr>' +
		sp(7, "Inner 1", undefined, `${xfrm(0, 0, 500, 500)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>`) +
		sp(8, "Inner 2", undefined, `${xfrm(500, 0, 500, 500)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>`) +
		"</p:grpSp>"
	const jump = sp(9, "Jump", undefined, `${xfrm(100, 3000, 500, 300)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>`)

	return {
		slides: [
			{
				shapes:
					shapes.replace(
						'<p:cNvPr id="5" name="Box C"/>',
						'<p:cNvPr id="5" name="Box C"><a:hlinkClick r:id="rId7" action="ppaction://hlinksldjump"/></p:cNvPr>'
					) + jump,
				rels: [["rId7", "slide", "slide3.xml"]],
				notes: para("Notes one")
			},
			{ shapes: sp(2, "Title 1", 'type="title"', "", body(para("Second"))) + sp(3, "Body", 'idx="1"', "", body(para("Text"))) },
			{ shapes: sp(2, "Title 1", 'type="title"', "", body(para("Third"))) },
			{ shapes: sp(2, "Title 1", 'type="title"', "", body(para("Fourth"))), layout: 2 }
		],
		presentation:
			'<p:custShowLst><p:custShow name="Short" id="0"><p:sldLst><p:sld r:id="rId101"/><p:sld r:id="rId103"/></p:sldLst></p:custShow></p:custShowLst>' +
			`<p:extLst><p:ext uri="${SECTION_EXT}"><p14:sectionLst ${P14}>` +
			'<p14:section name="First" id="{11111111-1111-1111-1111-111111111111}"><p14:sldIdLst><p14:sldId id="256"/><p14:sldId id="257"/></p14:sldIdLst></p14:section>' +
			'<p14:section name="Rest" id="{22222222-2222-2222-2222-222222222222}"><p14:sldIdLst><p14:sldId id="258"/><p14:sldId id="259"/></p14:sldIdLst></p14:section>' +
			"</p14:sectionLst></p:ext></p:extLst>"
	}
}

export function editDeck(): Uint8Array {
	return buildPptx(editDeckOptions())
}

export function shapeById(shapes: readonly ShapeNode[], id: number): ShapeNode | undefined {
	for (const shape of shapes) {
		if (shape.id === id) return shape

		const inner = shape.children === undefined ? undefined : shapeById(shape.children, id)

		if (inner !== undefined) return inner
	}

	return undefined
}

export { slideRef }
