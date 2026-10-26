import type { FontRequest } from "../../../core/fonts/index"
import type { Slicing } from "../../../core/opc/index"
import { PresentationError, type Refused, type ShapeRef, type TextBody } from "../../../core/presentation/model"
import type { TextPage, TransferableTextLayout } from "../../../core/presentation/output"
import { fontRequests, layoutBody, type LayoutOptions, type TextEnvironment } from "../../../core/presentation/text/body"
import { resolveBody, type BodyContext } from "../../../core/presentation/text/resolve"
import { transferableLayout } from "../../../core/presentation/text/transfer"
import type { EngineSession, TextCapability } from "../engine"

// The text capability. layoutText lays out a body the editor holds (not committed yet) in its shape's inheritance
// chain and box, in this worker, the session's one measuring realm, so the editor's line breaks equal the
// render's. textSeed belongs to the text editor and stays refused until it is registered.

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

export const textCapability: TextCapability = {
	textSeed: () => Promise.reject(new PresentationError("notImplemented", "textSeed")),
	layoutText: (context, shape, body) => layoutShapeText(context.session, shape, body, context.slicing)
}
