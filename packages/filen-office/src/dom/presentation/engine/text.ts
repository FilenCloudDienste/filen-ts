import type { FontRequest } from "../../../core/fonts/index"
import type { Slicing } from "../../../core/opc/index"
import { findShape } from "../../../core/presentation/edit/changes"
import { PresentationError, type Refused, type RunProps, type ShapeRef, type TextBody } from "../../../core/presentation/model"
import type { TextPage, TextSeed, TransferableTextLayout } from "../../../core/presentation/output"
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

	// One body per shape: a table holds one per cell, a picture, a group or a frame none.
	if (model !== undefined && model.kind !== "sp") throw new PresentationError("unsupported", `a ${model.kind} holds no text body`)

	// The slide's own layer of the shape (a layout's or master's layer names its own node).
	const layer = render.layers.find(item => item.shape.slide === shape.slide && item.shape.id === shape.id)

	if (layer === undefined || model === undefined) throw new PresentationError("notFound", "the shape is not on the slide")
	if (layer.lock !== undefined) throw new PresentationError("locked", layer.lock)

	const found = await services.shapeText(session, shape, context.slicing)

	if (found.kind === "refused") throw new PresentationError(found.reason, found.detail ?? "textSeed")

	const body: TextBody = model.text ?? { bodyPr: {}, paragraphs: [] }
	const resolved = resolveBody(body, found.context)

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
		matrix: layer.textMatrix ?? layer.matrix
	}
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
