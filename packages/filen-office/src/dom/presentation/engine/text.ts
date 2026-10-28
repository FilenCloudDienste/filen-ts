import type { FontRequest } from "../../../core/fonts/index"
import type { Slicing } from "../../../core/opc/index"
import { findShape } from "../../../core/presentation/edit/changes"
import { PresentationError, type Refused, type RunProps, type ShapeRef, type TextBody } from "../../../core/presentation/model"
import type { SlideLayer, TextPage, TextSeed, TransferableTextLayout } from "../../../core/presentation/output"
import { editableParagraphs } from "../../../core/presentation/text/editable"
import { fontRequests, layoutBody, type LayoutOptions, type TextEnvironment } from "../../../core/presentation/text/body"
import { resolveBody, type BodyContext } from "../../../core/presentation/text/resolve"
import { transferableLayout } from "../../../core/presentation/text/transfer"
import type { CallContext, EngineSession, TextCapability } from "../engine"
import { writeTextMailbox } from "../textMailbox"
import { renderSlideFor } from "./view"

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

	const result = layoutBody(resolved, found.box, found.environment, found.options)

	return { page: result.page, layout: transferableLayout(result), revision: found.revision }
}

// The editor's start on one shape's body. The slide is rendered for the shape's text matrix (the render also reads
// the shape's text context once per slide revision); the body is laid out here, in the session's measuring realm.
export async function textSeedOf(context: CallContext, shape: ShapeRef): Promise<TextSeed> {
	const session = context.session
	const services = servicesOf(session)
	const render = await renderSlideFor(context, shape.slide)
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
	textSeed: (context, shape) => textSeedOf(context, shape),
	layoutText: async (context, shape, body, _caretHint, mailbox) => {
		const result = await layoutShapeText(context.session, shape, body, context.slicing)

		// Written before the answer is posted (which transfers its buffers): the page may read it in its next frame.
		if (mailbox !== undefined) writeTextMailbox(mailbox, result)

		return result
	}
}
