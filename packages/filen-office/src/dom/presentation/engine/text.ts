import { reviveNotesFor } from "./edit"
import type { FontRequest } from "../../../core/fonts/index"
import type { Slicing } from "../../../core/opc/index"
import { findShape } from "../../../core/presentation/edit/changes"
import {
	PresentationError,
	type Refused,
	type RunProps,
	type ShapeNode,
	type ShapeRef,
	type TextBody
} from "../../../core/presentation/model"
import type { SlideLayer, TextPage, TextSeed, TransferableTextLayout } from "../../../core/presentation/output"
import { editableParagraphs } from "../../../core/presentation/text/editable"
import type { DeckOp } from "../../../core/presentation/edit/ops"
import { resolveShape } from "../../../core/presentation/inherit"
import { refitNormAutofit, spAutoFitXfrm } from "../../../core/presentation/text/autofit"
import { turnOf } from "../../../core/presentation/text/vertical"
import { fontRequests, layoutBody, type LayoutOptions, type TextEnvironment } from "../../../core/presentation/text/body"
import { resolveBody, type BodyContext } from "../../../core/presentation/text/resolve"
import { transferableLayout } from "../../../core/presentation/text/transfer"
import type { CallContext, EngineSession, TextCapability } from "../engine"
import { writeTextMailbox } from "../textMailbox"
import { renderNodeFor, renderSlideFor } from "./view"

// The text capability. layoutText lays out a body the editor holds (not committed yet) in its shape's inheritance
// chain and box, in this worker, the session's one measuring realm, so the editor's line breaks equal the
// render's. textSeed starts the editor on a body: the body as the model holds it, its properties resolved along the
// chain (for the ribbon), its layout, and the text matrix the slide's render places it with.

// What a shape's text needs from the session: its chain, theme bindings and box (the renderer's resolved element
// of the shape) and the session's measuring environment. The host registers it as EngineServices.text.
export interface TextServices {
	shapeText(session: EngineSession, shape: ShapeRef, slicing: Slicing): Promise<ShapeTextContext | Refused>
}

export interface ShapeTextContext {
	readonly kind: "shapeText"
	readonly context: BodyContext
	// The text rectangle minus insets, px (vert and vert270 turn it).
	readonly box: { readonly width: number; readonly height: number }
	readonly environment: TextEnvironment
	// Loads the faces `requests` name (a typed run may ask for a font the slide had not used).
	prepare(requests: readonly FontRequest[]): Promise<void>
	readonly options: LayoutOptions
	// Whether an edited body's autofit is found anew (refitNormAutofit, spAutoFitXfrm) rather than drawn as stored.
	readonly refit: boolean
	// The slide's revision the context was read at.
	readonly revision: number
}

function servicesOf(session: EngineSession): TextServices {
	const services = session.services.text

	if (services === undefined) throw new PresentationError("notImplemented", "layoutText: no text services")

	return services
}

export async function layoutShapeText(
	session: EngineSession,
	shape: ShapeRef,
	body: TextBody,
	slicing: Slicing
): Promise<{ readonly page: TextPage; readonly layout: TransferableTextLayout; readonly revision: number }> {
	const found = await servicesOf(session).shapeText(session, shape, slicing)

	if (found.kind === "refused") throw new PresentationError(found.reason, found.detail ?? "layoutText")

	const resolved = resolveBody(body, found.context)

	await found.prepare(fontRequests(resolved))

	// The body being edited shows the fit its text will commit with (autofit.ts refits the committed body the same way).
	const result =
		found.refit && resolved.bodyPr.autofit === "normal"
			? refitNormAutofit(resolved, found.box, found.environment, found.options).layout
			: layoutBody(resolved, found.box, found.environment, found.options)

	return { page: result.page, layout: transferableLayout(result), revision: found.revision }
}

// A setText with the autofit PowerPoint gives its new text: a normAutofit body's fontScale and lnSpcReduction found
// anew (in the body, so the step's inverse puts the old ones back), a spAutoFit shape's box sized to the text (a batch:
// one step). Any other op, a body that does not autofit or refit, and a shape without text services, as it is.
export async function autofitOp(session: EngineSession, op: DeckOp, slicing: Slicing): Promise<DeckOp> {
	const services = session.services.text

	if (services === undefined || op.family !== "text" || op.kind !== "setText" || op.target.cell !== undefined) return op

	const node = session.deck.nodes.get(op.target.slide)
	const at = node === undefined ? undefined : findShape(node.shapes, op.target.id)

	if (node === undefined || at === undefined || at.shape.kind !== "sp") return op

	let found: ShapeTextContext | Refused

	try {
		found = await services.shapeText(session, op.target, slicing)
	} catch (error) {
		// The op is applied as it is: its own apply answers for a shape the render could not read.
		if (error instanceof PresentationError) return op

		throw error
	}

	if (found.kind === "refused" || !found.refit) return op

	const resolved = resolveBody(op.body, found.context)
	const bodyPr = resolved.bodyPr

	if (bodyPr.autofit !== "normal" && bodyPr.autofit !== "shape") return op

	await found.prepare(fontRequests(resolved))

	if (bodyPr.autofit === "normal") {
		const fit = refitNormAutofit(resolved, found.box, found.environment, found.options)

		if (sameFit(fit.fontScale, bodyPr.fontScale) && sameFit(fit.lineSpacingReduction, bodyPr.lineSpacingReduction)) return op

		return {
			...op,
			body: {
				...op.body,
				bodyPr: { ...op.body.bodyPr, autofit: "normal", fontScale: fit.fontScale, lineSpacingReduction: fit.lineSpacingReduction }
			}
		}
	}

	// A shape locked against moving keeps its box (its text is still edited).
	if (at.shape.lock !== undefined && at.shape.lock !== "alternateContent" && at.shape.lock !== "unknownFrame") return op

	const xfrm = at.shape.xfrm ?? resolveShape(session.deck, node.ref, at.shape).xfrm

	if (xfrm === undefined) return op

	const needed = layoutBody(resolved, found.box, found.environment, found.options).height
	const next = spAutoFitXfrm(xfrm, bodyPr.vertical, found.box, needed, childScale(node.shapes, at.parent, turnOf(bodyPr.vertical) !== 0))

	return next === undefined
		? op
		: { family: "batch", kind: "batch", ops: [op, { family: "shape", kind: "setXfrm", target: op.target, xfrm: next }] }
}

// fontScale and lnSpcReduction as the file writes them (1/100,000).
function sameFit(a: number, b: number): boolean {
	return Math.round(a * 100_000) === Math.round(b * 100_000)
}

// A group child's EMU per slide EMU along x (`horizontal`) or y: each enclosing group's child extent over its extent.
function childScale(shapes: readonly ShapeNode[], parent: number, horizontal: boolean): number {
	let scale = 1
	let id = parent

	while (id !== 0) {
		const group = findShape(shapes, id)

		if (group === undefined) break

		const xfrm = group.shape.xfrm
		const extent = horizontal ? xfrm?.cx : xfrm?.cy
		const child = horizontal ? xfrm?.chCx : xfrm?.chCy

		if (extent !== undefined && child !== undefined && extent > 0 && child > 0) scale *= child / extent

		id = group.parent
	}

	return scale
}

// The editor's start on one shape's body. The slide is rendered for the shape's text matrix (the render also reads
// the shape's text context once per slide revision); the body is laid out here, in the session's measuring realm.
export async function textSeedOf(context: CallContext, shape: ShapeRef): Promise<TextSeed> {
	const session = context.session
	const services = servicesOf(session)
	// A notes body (the notes pane's) on its notes page; any other on its slide.
	const render = session.deck.slides.includes(shape.slide)
		? await renderSlideFor(context, shape.slide)
		: await renderNodeFor(context, shape.slide)
	const node = session.deck.nodes.get(shape.slide)
	const model = node === undefined ? undefined : findShape(node.shapes, shape.id)?.shape

	const cell = shape.cell
	const table = model?.frame?.kind === "table" ? model.frame.table : undefined
	const cellModel = cell === undefined ? undefined : table?.rows[cell.row]?.cells[cell.col]

	// One body per shape, a table one per cell; a picture, a group or another frame none.
	if (model !== undefined && (cell === undefined ? model.kind !== "sp" : cellModel === undefined))
		throw new PresentationError("unsupported", cell === undefined ? `a ${model.kind} holds no text body` : "no such table cell")
	if (cellModel?.hMerge === true || cellModel?.vMerge === true) throw new PresentationError("unsupported", "a cell another cell covers")

	// The slide's own layer of the shape (a layout's or master's layer names its own node); a cell's text layer, else
	// the table's own layer with the cell's text box.
	const layers = render.layers.filter(item => item.shape.slide === shape.slide && item.shape.id === shape.id)
	const layer =
		cell === undefined
			? layers[0]
			: (layers.find(item => item.cell?.[0] === cell.row && item.cell[1] === cell.col) ??
				layers.find(item => item.table !== undefined))

	if (layer === undefined || model === undefined) throw new PresentationError("notFound", "the shape is not on the slide")
	if (layer.lock !== undefined) throw new PresentationError("locked", layer.lock)

	const found = await services.shapeText(session, shape, context.slicing)

	if (found.kind === "refused") throw new PresentationError(found.reason, found.detail ?? "textSeed")

	const body: TextBody = cellModel?.text ?? model.text ?? { bodyPr: {}, paragraphs: [] }
	// Laid out and resolved as the editor shows it: a body without paragraphs as one empty paragraph.
	const resolved = resolveBody({ ...body, paragraphs: editableParagraphs(body) }, found.context)

	await found.prepare(fontRequests(resolved))

	const result = layoutBody(resolved, found.box, found.environment, found.options)

	return {
		shape,
		revision: found.revision,
		body,
		resolved: resolved.paragraphs.map(paragraph => ({
			pPr: paragraph.pPr,
			runs: paragraph.runs.map((run): RunProps => (run.kind === "opaque" ? paragraph.defRPr : run.rPr))
		})),
		page: result.page,
		layout: transferableLayout(result),
		matrix: layer.textMatrix ?? cellMatrix(layer, cell) ?? layer.matrix
	}
}

// A cell's text box on the table's own layer, as a matrix (a cell with no text has no text layer of its own).
function cellMatrix(layer: SlideLayer, cell: ShapeRef["cell"]): readonly number[] | undefined {
	const table = layer.table

	if (cell === undefined || table === undefined) return undefined

	for (let k = 0; k * 4 + 3 < table.areas.length; k++) {
		if (table.areas[k * 4] !== cell.row || table.areas[k * 4 + 1] !== cell.col) continue

		const [a = 1, b = 0, c = 0, d = 1, e = 0, f = 0] = layer.matrix
		const x = table.textBoxes[k * 4] ?? 0
		const y = table.textBoxes[k * 4 + 1] ?? 0

		return [a, b, c, d, a * x + c * y + e, b * x + d * y + f]
	}

	return undefined
}

export const textCapability: TextCapability = {
	// A body of notes a save took back (dormant) is made again first: the editor on it goes on.
	textSeed: async (context, shape) => {
		await reviveNotesFor(context, shape)

		return textSeedOf(context, shape)
	},
	layoutText: async (context, shape, body, _caretHint, mailbox) => {
		await reviveNotesFor(context, shape)

		const result = await layoutShapeText(context.session, shape, body, context.slicing)

		// Written before the answer is posted (which transfers its buffers): the page may read it in its next frame.
		if (mailbox !== undefined) writeTextMailbox(mailbox, result)

		return result
	}
}
