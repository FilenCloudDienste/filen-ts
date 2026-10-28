import { bytesSource } from "../core/opc/index"
import type { PdfSecurityKey } from "../core/pdfwrite/crypto"
import type { SlideRef } from "../core/presentation/model"
import type { HandoutsPerPage, SlideExport } from "../core/presentation/pages"
import { SERVICES, type CallContext, type EngineSession } from "../dom/presentation/engine"
import { layerKinds, serveJobsPort, type JobsPortEnd } from "../dom/presentation/engine/jobs"
import { openPptxCapability } from "../dom/presentation/engine/open/pptx"
import { presentationTextServices, renderSlideFor } from "../dom/presentation/engine/view"
import { jobSessionOver } from "../dom/presentation/jobsWorker"
import { pdfJob } from "../dom/presentation/jobs/pdf"
import type { JobOutcome, JobSession } from "../dom/presentation/jobs/registry"
import { installJobsRealm } from "../dom/presentation/raster"
import { installPresentationRealm, type RealmCanvas } from "../dom/presentation/services"
import { PdfWriteError, type PdfImageDecoder } from "../core/pdfwrite/index"
import { pdfAssets } from "./docxPdfFixtures"
import { decodePng } from "./oracles/presentation/pixel"
import { HmtxMeasurer, nodeFontAssets } from "./layoutFixtures"

// Decks opened in this thread with real metrics, exported to PDF by the PDF job itself over the session's jobsPort,
// without workers.

export function installTestRealm(): void {
	installPresentationRealm({
		text: {
			fontHost: { addBytes: () => Promise.resolve(true), addLocal: () => Promise.resolve(false), remove: () => undefined },
			replayFonts: true,
			fontAssets: nodeFontAssets,
			measurer: new HmtxMeasurer(),
			yield: () => Promise.resolve()
		},
		canvas: {
			canvas: () => undefined,
			decode: () => Promise.resolve(undefined),
			copy: () => Promise.resolve(undefined),
			fontsReady: () => Promise.resolve()
		}
	})
}

export async function openDeck(bytes: Uint8Array, password?: string): Promise<CallContext> {
	const options = { format: "pptx" as const, fileName: "deck.pptx" }
	const outcome = await openPptxCapability.open({
		source: bytesSource(bytes),
		sourceKind: "bytes",
		options,
		...(password === undefined ? {} : { password })
	})

	if (outcome.kind !== "opened") throw new Error(outcome.kind === "refused" ? outcome.reason : outcome.kind)

	const closers: (() => void)[] = []
	const session: EngineSession = {
		s: 1,
		deck: outcome.deck,
		package: outcome.package,
		options,
		services: { ...SERVICES, text: presentationTextServices },
		rangeSource: undefined,
		schedule: () => undefined,
		emit: () => undefined,
		onClose: listener => {
			closers.push(listener)
		}
	}

	return {
		session,
		signal: { aborted: false, onAbort: () => undefined },
		lane: "background",
		slicing: { pause: () => Promise.resolve(), sliceMs: 50, now: () => Date.now() }
	}
}

export async function exportSlide(context: CallContext, ref: SlideRef): Promise<SlideExport> {
	const render = await renderSlideFor(context, ref)

	return { render, kinds: layerKinds(context.session.deck.nodes.get(ref), render) }
}

// PNG pictures decoded in Node (the browsers' jobs worker decodes with createImageBitmap); other formats refused.
export const nodePngDecoder: PdfImageDecoder = {
	decode: async (data, format) => {
		if (format !== "png") throw new PdfWriteError("imageUnsupported", `no ${format} decoder in Node`)

		const bytes = data instanceof Uint8Array ? data : new Uint8Array(await data.arrayBuffer())
		let image: ReturnType<typeof decodePng>

		try {
			image = decodePng(bytes)
		} catch (error) {
			throw new PdfWriteError("imageUnsupported", error instanceof Error ? error.message : "undecodable PNG")
		}

		return { width: image.width, height: image.height, rgba: image.data }
	}
}

export interface ExportOptions {
	readonly layout?: "slides" | "handouts"
	readonly perPage?: HandoutsPerPage
	readonly securityKey?: PdfSecurityKey
	readonly refs?: readonly SlideRef[]
	// The realm's canvas (SVG pictures drawn through its svg()); none by default.
	readonly canvas?: RealmCanvas
	// After each page is written (memory samples).
	readonly onPage?: (page: number) => void
}

function joined(chunks: readonly Uint8Array[], size: number): Uint8Array {
	const out = new Uint8Array(size)
	let at = 0

	for (const chunk of chunks) {
		out.set(chunk, at)
		at += chunk.length
	}

	return out
}

// The session as a jobs worker reads it: served by the session's jobsPort over a real channel.
export function jobSession(context: CallContext): { readonly session: JobSession; close(): void } {
	const channel = new MessageChannel()

	serveJobsPort(context, channel.port1 as unknown as JobsPortEnd)

	return jobSessionOver(channel.port2 as unknown as JobsPortEnd)
}

// The deck's slides (or `refs`) as a PDF, slides one per page or handouts, made by the PDF job itself (as the jobs
// worker runs it) over the session's port; deterministic unless encrypted.
export async function deckPdf(
	context: CallContext,
	options: ExportOptions = {}
): Promise<{ bytes: Uint8Array; outcome: Extract<JobOutcome, { kind: "done" }> }> {
	installJobsRealm({
		assets: pdfAssets,
		lang: "en-GB",
		decoder: nodePngDecoder,
		...(options.canvas === undefined ? {} : { canvas: options.canvas })
	})

	const reader = jobSession(context)
	const securityKey = options.securityKey
	const session: JobSession =
		securityKey === undefined ? reader.session : { ...reader.session, pdfSecurity: () => Promise.resolve(securityKey) }
	const chunks: Uint8Array[] = []
	let size = 0

	try {
		const outcome = await pdfJob.run(
			{
				layout: options.layout ?? "slides",
				...(options.perPage === undefined ? {} : { perPage: options.perPage }),
				...(options.refs === undefined ? {} : { slides: options.refs }),
				includeHidden: true,
				protect: securityKey !== undefined,
				deterministic: securityKey === undefined
			},
			{
				session,
				output: {
					write: chunk => {
						chunks.push(chunk)
						size += chunk.length

						return Promise.resolve()
					},
					close: () => Promise.resolve()
				},
				signal: { aborted: false, onAbort: () => undefined },
				progress: done => options.onPage?.(done - 1)
			}
		)

		if (outcome.kind !== "done") throw new Error(`the PDF job refused: ${outcome.reason} ${outcome.detail ?? ""}`)

		return { bytes: joined(chunks, size), outcome }
	} finally {
		reader.close()
		installJobsRealm(undefined)
	}
}
