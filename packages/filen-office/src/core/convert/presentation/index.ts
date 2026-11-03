import type { OdpParts } from "../../odp/read/document"
import { writeFreshOdp, type FreshReport } from "../../odp/write/fresh"
import type { ByteSink, OpcPackage } from "../../opc/index"
import type { PptLoss } from "../../ppt/report"
import { writePptConversion } from "../../ppt/toPptx"
import type { PptxParts } from "../../pptx/package"
import { freshPptxWith } from "../../pptx/write/fresh"
import type { PptxSource } from "../../pptx/write/types"
import { refused, type Deck, type Format, type Refused } from "../../presentation/model"
import type { Slicing } from "../../slicing"
import { odpToPptxAdapter } from "./fromOdp"
import { odpObjects } from "./odpElements"
import { pptxServices, type PptxServicesOptions } from "./pptxServices"
import { ConversionReport, type ConversionLoss, type ConversionLossKind } from "./report"

export { ConversionReport, type ConversionLoss, type ConversionLossKind } from "./report"

// Conversions between presentation formats, each through a fresh writer over the open deck's model (so a deck's
// unsaved edits are converted): PresentationML to ODF (freshOdp), ODF to PresentationML and a gated or Strict
// PresentationML deck to a Transitional copy (freshPptx), a PowerPoint 97–2003 deck to PresentationML (the package it
// was converted to when opened) and to ODF (that package's deck through freshOdp). What the target holds differently
// is reported by kind. A password-protected source converts to PresentationML only, sealed by the caller under the
// same password (`seal`); an ODF copy cannot keep the protection, so it is refused.

export type PresentationTarget = "pptx" | "odp"

// The targets each source format converts to.
export const CONVERSIONS: Readonly<Record<Format, readonly PresentationTarget[]>> = {
	pptx: ["odp", "pptx"],
	odp: ["pptx"],
	ppt: ["pptx", "odp"]
}

// What a deck's session holds that a conversion reads.
export type ConversionSource =
	| { readonly format: "pptx"; readonly parts: PptxParts; readonly source: PptxSource }
	| { readonly format: "odp"; readonly parts: OdpParts }
	// `losses`: the deck's conversion losses as they stand (writing the package can add one).
	| { readonly format: "ppt"; readonly parts: PptxParts; readonly pptx: OpcPackage; readonly losses: () => readonly PptLoss[] }

export interface ConvertOptions {
	readonly slicing?: Slicing
	// Seals a PresentationML package under the source's password (an encrypted source only).
	readonly seal?: (zip: Uint8Array) => Promise<Uint8Array>
	// Lays out a diagram that has no drawing cache (to ODF it is written as the shapes it is drawn with).
	readonly relayout?: PptxServicesOptions["relayout"]
	// An SVG picture rasterised as PNG (to PresentationML it is shown by one beside the SVG); undefined where it cannot be.
	readonly svgPng?: (svg: Uint8Array) => Promise<Uint8Array | undefined>
}

export interface Converted {
	readonly target: PresentationTarget
	readonly bytes: number
	readonly losses: readonly ConversionLoss[]
}

function encrypted(deck: Deck): boolean {
	return deck.protection.encrypted !== undefined
}

// Whether `deck` converts to `target`: a PresentationML deck to a PresentationML copy only when it is gated (a Strict,
// signed or write-reserved deck, which cannot be edited in place); never an encrypted deck to ODF.
export function canConvertPresentation(deck: Deck, target: PresentationTarget): boolean {
	if (!CONVERSIONS[deck.format].includes(target)) return false
	if (target === "odp" && encrypted(deck)) return false
	if (deck.format === "pptx" && target === "pptx") return deck.gate.length > 0

	return true
}

// The fresh ODP writer's report by loss kind.
const FRESH_KINDS: readonly (readonly [RegExp, ConversionLossKind])[] = [
	[/fill$/u, "fill"],
	[/^(dashed line|line end)$/u, "line"],
	[/^outline level /u, "outlineLevel"],
	[/^outline /u, "geometry"],
	[/^(vertical |line-breaking|spacing|bullet size|numbering |run kept|picture bullet)/u, "text"],
	[/^table style/u, "tableStyle"],
	[/^chart$/u, "chartDetail"],
	[/^chart frame/u, "chart"],
	[/^smartart frame/u, "smartArt"],
	[/^animation triggered by a bookmark/u, "bookmarkTrigger"],
	[/^media (trim|fade|bookmark)/u, "mediaTiming"],
	[/^(media frame|audio|video)/u, "media"],
	[/^ole frame/u, "oleObject"],
	[/^ink$/u, "ink"],
	[/^background/u, "background"],
	[/^animation/u, "animation"],
	[/^transition/u, "transition"],
	[/^picture$/u, "picture"],
	[/^(kiosk|narration|pen colour|pause|slide range)/u, "showSettings"]
]

function freshKind(what: string): ConversionLossKind {
	for (const [pattern, kind] of FRESH_KINDS) if (pattern.test(what)) return kind

	// A shape written in no form ("shape (…)", a mirrored group, a table frame without a box, opaque content).
	return "shape"
}

export function noteFresh(report: ConversionReport, fresh: FreshReport): void {
	for (const table of [fresh.approximated, fresh.omitted])
		for (const [what, count] of Object.entries(table)) report.note(freshKind(what), count)
}

// What a copy of a gated deck drops: the signature, the write reservation.
function noteGate(report: ConversionReport, deck: Deck): void {
	if (deck.gate.includes("signed")) report.note("signature")
	if (deck.protection.modifyVerifier !== undefined) report.note("writeReservation")
}

// ST_SlideSizeCoordinate (ECMA-376 Part 1 §19.7.16): 1 to 56 inches.
const MIN_SLIDE = 914_400
const MAX_SLIDE = 51_206_400

// The slide size PresentationML can hold when the deck's is outside it (an ODF page can be larger), else undefined.
function slideSize(deck: Deck, report: ConversionReport): { readonly cx: number; readonly cy: number } | undefined {
	const clamp = (value: number): number => Math.min(MAX_SLIDE, Math.max(MIN_SLIDE, Math.round(value)))
	const cx = clamp(deck.size.cx)
	const cy = clamp(deck.size.cy)

	if (cx === deck.size.cx && cy === deck.size.cy) return undefined

	report.note("slideSize")

	return { cx, cy }
}

// A sink that keeps what is written (a package sealed before it reaches the real sink).
function heldSink(): ByteSink & { bytes(): Uint8Array } {
	const chunks: Uint8Array[] = []
	let size = 0

	return {
		write: chunk => {
			chunks.push(chunk)
			size += chunk.length

			return Promise.resolve()
		},
		close: () => Promise.resolve(),
		bytes: () => {
			const out = new Uint8Array(size)
			let at = 0

			for (const chunk of chunks) {
				out.set(chunk, at)
				at += chunk.length
			}

			chunks.length = 0

			return out
		}
	}
}

const CHUNK = 1024 * 1024

async function sealed(zip: Uint8Array, seal: (zip: Uint8Array) => Promise<Uint8Array>, sink: ByteSink): Promise<number> {
	const bytes = await seal(zip)

	for (let at = 0; at < bytes.length; at += CHUNK) await sink.write(bytes.subarray(at, Math.min(bytes.length, at + CHUNK)))
	await sink.close()

	return bytes.length
}

// A sink counting what passes through it.
function counted(sink: ByteSink): ByteSink & { readonly size: number } {
	let size = 0

	return {
		get size() {
			return size
		},
		write: chunk => {
			size += chunk.length

			return sink.write(chunk)
		},
		close: () => sink.close()
	}
}

// Every slide and notes page of the deck parsed (a conversion writes all of them).
async function parseAll(input: ConversionSource, deck: Deck, slicing: Slicing | undefined): Promise<void> {
	await input.parts.parseAll(slicing)

	if (input.format === "odp") return

	for (const ref of deck.slides) {
		const notes = deck.nodes.get(ref)?.notes

		if (notes !== undefined && !deck.nodes.has(notes)) await input.parts.slide(notes, slicing)
	}
}

// `deck` written as `target` to `sink`.
export async function convertPresentation(
	deck: Deck,
	input: ConversionSource,
	target: PresentationTarget,
	sink: ByteSink,
	options: ConvertOptions = {}
): Promise<Converted | Refused> {
	if (!CONVERSIONS[deck.format].includes(target) || input.format !== deck.format)
		return refused("unsupported", `${deck.format} to ${target}`)
	if (target === "odp" && encrypted(deck)) return refused("encrypted", "An OpenDocument copy cannot keep the password")
	if (encrypted(deck) && options.seal === undefined) return refused("encrypted", "No sealer for the protected copy")

	const report = new ConversionReport()

	// A copy of a signed or write-reserved deck keeps neither, whatever its format.
	noteGate(report, deck)

	// A PowerPoint 97–2003 deck as .pptx is the package it was converted to. Its losses are read after the write: an
	// embedded object's storage found damaged while it is written adds one.
	if (input.format === "ppt" && target === "pptx") {
		const slicing = options.slicing === undefined ? {} : { slicing: options.slicing }
		let bytes: number

		if (options.seal !== undefined) {
			const held = heldSink()

			await writePptConversion(input.pptx, held, slicing)
			bytes = await sealed(held.bytes(), options.seal, sink)
		} else bytes = (await writePptConversion(input.pptx, sink, slicing)).size

		report.addPpt(input.losses())

		return { target, bytes, losses: report.losses() }
	}

	if (input.format === "ppt") report.addPpt(input.losses())

	await parseAll(input, deck, options.slicing)

	if (target === "odp") {
		if (input.format === "odp") return refused("unsupported", "odp to odp")

		const services = pptxServices(deck, input.parts, options.relayout === undefined ? {} : { relayout: options.relayout })

		await services.preload()

		const out = counted(sink)
		const written = await writeFreshOdp(deck, services, out)

		if ("kind" in written) return written

		noteFresh(report, written.report)

		return { target, bytes: out.size, losses: report.losses() }
	}

	const source: PptxSource | undefined = input.format === "pptx" ? input.source : undefined
	const objects = input.format === "odp" ? await odpObjects(deck, input.parts, report, options.svgPng) : undefined
	const size = slideSize(deck, report)
	const extras = {
		...(objects === undefined
			? {}
			: {
					foreign: objects.parts,
					adapt: odpToPptxAdapter(deck, report, objects.parts),
					element: objects.element,
					svgFallback: objects.svgFallback
				}),
		...(size === undefined ? {} : { size })
	}
	const held = options.seal === undefined ? undefined : heldSink()
	const out = counted(held ?? sink)
	const written = await freshPptxWith(deck, source, out, options.slicing === undefined ? {} : { slicing: options.slicing }, extras)

	if (written.kind === "refused") return written
	if (written.kind !== "written") return refused("failed", "The fresh package was not written")

	const bytes = held === undefined || options.seal === undefined ? out.size : await sealed(held.bytes(), options.seal, sink)

	return { target, bytes, losses: report.losses() }
}
