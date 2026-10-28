import type { PptxServicesOptions } from "../../../core/convert/presentation/pptxServices"
import {
	canConvertPresentation,
	convertPresentation,
	type ConversionSource,
	type PresentationTarget
} from "../../../core/convert/presentation/index"
import type { Slicing } from "../../../core/opc/index"
import { PresentationError, type Deck } from "../../../core/presentation/model"
import type { XmlDocument } from "../../../core/xml/index"
import { packageSealer } from "../../encryption/seal"
import { passwordOfficeKey } from "../../encryption/webCrypto"
import type { ConvertCapability, EngineSession } from "../engine"
import type { ConversionReport, PortLike } from "../protocol"
import { deckTurn } from "../save"
import { SavePortAbortedError, savePortWriter, type SavePortEnd } from "../savePort"
import { presentationRealm } from "../services"
import { MAX_SVG_BYTES } from "../svgPort"
import { odpParts } from "./open/odp"
import { pptLosses, pptPassword } from "./open/ppt"
import { pptxParts } from "./open/pptx"
import { pptxSaveSource, sealPptx } from "./save"
import { AVERAGE_MEASURER, relayoutDiagram } from "./smartart"

// freshParts: the session's deck, unsaved edits included, written as a new package of the other format (or a
// Transitional copy of a gated PresentationML deck) and streamed to the port (savePort.ts; the page reads it or an
// upload takes it), through the conversions of core/convert/presentation. It runs as one turn of the deck, after the
// commands before it. A password-protected deck's PresentationML copy is sealed as Agile under the same key (an
// encrypted pptx through its save sealer, a PowerPoint 97–2003 deck under its open password); its ODF copy is refused
// "encrypted" (an OpenDocument copy cannot keep the protection) before the port is touched.

// A PresentationML package sealed as Agile under `password` (a PowerPoint 97–2003 deck's copy, under its open password).
export function passwordSeal(password: string, slicing?: Slicing): (zip: Uint8Array) => Promise<Uint8Array> {
	return async zip => {
		const { sealer, release } = packageSealer(await passwordOfficeKey(password))

		try {
			return await sealer.seal(zip, slicing === undefined ? {} : { slicing })
		} finally {
			release()
		}
	}
}

// What the conversion reads of the session.
function conversionSource(session: EngineSession): ConversionSource {
	const deck = session.deck

	switch (deck.format) {
		case "pptx": {
			const parts = pptxParts(deck)

			if (parts === undefined) throw new PresentationError("notImplemented", "a pptx deck without its parts")

			return { format: "pptx", parts, source: pptxSaveSource(session) }
		}
		case "odp": {
			const parts = odpParts(deck)

			if (parts === undefined) throw new PresentationError("notImplemented", "an ODP deck without its parts")

			return { format: "odp", parts }
		}
		case "ppt": {
			const parts = pptxParts(deck)
			const pptx = session.package.opc

			if (parts === undefined || pptx === undefined) throw new PresentationError("notImplemented", "a ppt deck without its package")

			return { format: "ppt", parts, pptx, losses: () => pptLosses(deck) ?? [] }
		}
	}
}

// The sealer of a protected deck's PresentationML copy, else undefined.
function sealerOf(session: EngineSession, slicing: Slicing): ((zip: Uint8Array) => Promise<Uint8Array>) | undefined {
	const deck: Deck = session.deck

	if (deck.protection.encrypted === undefined) return undefined
	if (deck.format === "pptx") return zip => sealPptx(zip, deck, slicing)

	const password = pptPassword(deck)

	return password === undefined ? undefined : passwordSeal(password, slicing)
}

// An SVG picture's PNG for a PresentationML copy, drawn by the realm (a worker's asks the page, svgPort.ts) at most
// SVG_PNG_SIDE pixels on its longer side; undefined where the realm cannot draw SVG or encode PNG.
const SVG_PNG_SIDE = 2048

async function svgPng(svg: Uint8Array): Promise<Uint8Array | undefined> {
	const canvas = presentationRealm()?.canvas

	if (canvas?.svg === undefined || svg.length > MAX_SVG_BYTES) return undefined

	const bitmap = await canvas.svg(svg, SVG_PNG_SIDE)

	if (bitmap === undefined) return undefined

	try {
		const surface = canvas.canvas(bitmap.width, bitmap.height)
		const context = surface?.getContext("2d") ?? null
		const encode: unknown = surface === undefined ? undefined : Reflect.get(surface, "convertToBlob")

		if (surface === undefined || context === null || typeof encode !== "function") return undefined

		context.drawImage(bitmap, 0, 0, bitmap.width, bitmap.height)

		const blob = (await Reflect.apply(encode, surface, [{ type: "image/png" }])) as { arrayBuffer(): Promise<ArrayBuffer> }

		return new Uint8Array(await blob.arrayBuffer())
	} finally {
		bitmap.close()
	}
}

// A diagram without a drawing cache laid out by the SmartArt engine from its parts (text measured by average
// advances: the conversion runs without the view's measurer), its drawing markup as PowerPoint would cache it.
function relayoutOf(session: EngineSession): PptxServicesOptions["relayout"] {
	const parts = pptxParts(session.deck)

	if (parts === undefined) return undefined

	const xml = async (part: string): Promise<XmlDocument | undefined> => {
		const name = part.replace(/^\//u, "")

		return parts.opc.has(name) ? parts.opc.xml(name) : undefined
	}

	return async (frame, box) => {
		const [data, layout, style, colors] = await Promise.all([xml(frame.data), xml(frame.layout), xml(frame.style), xml(frame.colors)])

		if (data === undefined || layout === undefined) return undefined

		try {
			return relayoutDiagram({ data, layout, style, colors }, box, () => AVERAGE_MEASURER).drawingXml
		} catch (error) {
			if (error instanceof PresentationError && error.reason !== "aborted") return undefined

			throw error
		}
	}
}

export const convertCapability: ConvertCapability = {
	async freshParts(context, target: PresentationTarget, port: PortLike): Promise<ConversionReport> {
		const { session } = context
		const deck = session.deck

		if (!canConvertPresentation(deck, target))
			throw new PresentationError(
				target === "odp" && deck.protection.encrypted !== undefined ? "encrypted" : "unsupported",
				`${deck.format} to ${target}`
			)

		const input = conversionSource(session)
		const seal = sealerOf(session, context.slicing)
		const relayout = deck.format === "odp" ? undefined : relayoutOf(session)
		const writer = savePortWriter(port as SavePortEnd)

		context.signal.onAbort(() => {
			writer.abort("cancelled")
		})
		writer.announce()

		try {
			const converted = await deckTurn(deck, () =>
				convertPresentation(deck, input, target, writer, {
					slicing: context.slicing,
					...(seal === undefined ? {} : { seal }),
					...(target === "odp" && relayout !== undefined ? { relayout } : {}),
					...(target === "pptx" ? { svgPng } : {})
				})
			)

			if ("kind" in converted) throw new PresentationError(converted.reason, converted.detail ?? "conversion")

			writer.commit()

			return { target, bytes: converted.bytes, losses: converted.losses }
		} catch (error) {
			writer.abort(error instanceof SavePortAbortedError ? "cancelled" : "failed")

			throw error
		}
	}
}
