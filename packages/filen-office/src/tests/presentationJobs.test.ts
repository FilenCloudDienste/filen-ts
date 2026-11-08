import { execFileSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { CORPUS_DIR } from "./corpusDir"
import { bytesSource, type ByteSink } from "../core/opc/index"
import type { ShapeRef } from "../core/presentation/model"
import { SERVICES, type CallContext, type EngineSession } from "../dom/presentation/engine"
import { editCapability } from "../dom/presentation/engine/edit"
import { openOdpCapability } from "../dom/presentation/engine/open/odp"
import { presentationTextServices } from "../dom/presentation/engine/view"
import { presentationJobsRealm } from "../dom/presentation/raster"
import type { SvgRasterizer } from "../dom/presentation/svgPort"
import { serveJobsPort, type JobsPortEnd } from "../dom/presentation/engine/jobs"
import { presentationJobsClient, servePresentationJobsWorker, type PresentationJobsWorkerLike } from "../dom/presentation/jobsWorker"
import type { JobKind, JobOutcome, JobRequests } from "../dom/presentation/jobs/registry"
import { installPresentationRealm, type RealmCanvas } from "../dom/presentation/services"
import { pdfAssets, openPdf, pageText } from "./docxPdfFixtures"
import { body, buildPptx, COLOR_MAP, NS, para, sp, tree, xfrm } from "./pptxFixtures"
import { installTestRealm, nodePngDecoder, openDeck } from "./presentationExportFixtures"
import { agileStreams, encryptedOfficeFile } from "./encryption/testing"
import { DEFAULT_MASTER, odpBytes, page } from "./odpFixtures"

// Exports through the jobs worker as the page runs them: a worker (here in this thread) reads the session through a
// real MessageChannel to its jobsPort, unsaved edits included, and streams its bytes back over the pull protocol.

const EMU = 9525

function deck(): Uint8Array {
	const title = (text: string): string =>
		sp(2, "Title 1", 'type="title"', xfrm(100 * EMU, 40 * EMU, 760 * EMU, 80 * EMU), body(para(text)))

	return buildPptx({
		sldSz: '<p:sldSz cx="9144000" cy="5143500"/>',
		slides: [
			{ shapes: title("Opening"), notes: para("Greet the room") },
			{ shapes: title("Hidden one"), attributes: ' show="0"' },
			{ shapes: title("Closing") }
		],
		// A notes page of 7.5 x 10 in: the slide image above, the notes body below.
		notesMaster:
			`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:notesMaster ${NS}>` +
			tree(
				sp(2, "Slide Image Placeholder 1", 'type="sldImg"', xfrm(1143000, 685800, 4572000, 2571750)) +
					sp(3, "Notes Placeholder 2", 'type="body" idx="1"', xfrm(685800, 4343400, 5486400, 4114800))
			) +
			`<p:clrMap ${COLOR_MAP}/><p:notesStyle><a:lvl1pPr><a:defRPr sz="1200"><a:latin typeface="+mn-lt"/></a:defRPr></a:lvl1pPr></p:notesStyle></p:notesMaster>`
	})
}

// A jobs worker in this thread: messages cross as they are (ports included), a turn later.
function inThreadJobsWorker(canvas?: RealmCanvas): PresentationJobsWorkerLike {
	const toPage = new Set<(event: { readonly data: unknown }) => void>()
	const toWorker = new Set<(event: { readonly data: unknown }) => void>()
	let stopped = false
	const deliver = (listeners: Set<(event: { readonly data: unknown }) => void>, data: unknown): void => {
		void Promise.resolve().then(() => {
			if (!stopped) for (const listener of listeners) listener({ data })
		})
	}
	const stop = servePresentationJobsWorker(
		{
			postMessage: message => {
				deliver(toPage, message)
			},
			addEventListener: (_type, listener) => toWorker.add(listener),
			removeEventListener: (_type, listener) => toWorker.delete(listener)
		},
		{ assets: pdfAssets, lang: "en-GB", decoder: nodePngDecoder, ...(canvas === undefined ? {} : { canvas }) }
	)

	return {
		postMessage: message => {
			deliver(toWorker, message)
		},
		addEventListener: (_type, listener) => toPage.add(listener),
		terminate: () => {
			stopped = true
			stop()
		}
	}
}

const run = presentationJobsClient(inThreadJobsWorker)

async function job<K extends JobKind>(
	context: CallContext,
	kind: K,
	request: JobRequests[K],
	client: typeof run = run
): Promise<{ outcome: JobOutcome; bytes: Uint8Array }> {
	const progress: number[] = []
	const handle = client(
		kind,
		request,
		{
			jobsPort: port => {
				serveJobsPort(context, port as JobsPortEnd)

				return Promise.resolve()
			}
		},
		done => progress.push(done)
	)
	const chunks: Uint8Array[] = []
	const sink: ByteSink = { write: chunk => Promise.resolve(void chunks.push(chunk.slice())), close: () => Promise.resolve() }
	const reading = (async () => {
		for (let chunk = await handle.output.read(); chunk !== undefined; chunk = await handle.output.read()) await sink.write(chunk)
	})()
	const outcome = await handle.done

	if (outcome.kind === "done") await reading
	else await reading.catch(() => undefined)

	handle.close()

	const bytes = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0))
	let at = 0

	for (const chunk of chunks) {
		bytes.set(chunk, at)
		at += chunk.length
	}

	return { outcome, bytes }
}

beforeAll(() => {
	installTestRealm()
})

afterAll(() => {
	installPresentationRealm(undefined)
})

describe("presentation jobs over the jobs port", () => {
	it("exports the shown slides, leaving hidden ones out unless asked", { timeout: 60_000 }, async () => {
		const context = await openDeck(deck())
		const shown = await job(context, "pdf", { layout: "slides", includeHidden: false, protect: false })

		expect(shown.outcome).toMatchObject({ kind: "done", contentType: "application/pdf" })
		expect((await openPdf(shown.bytes)).numPages).toBe(2)

		const all = await job(context, "pdf", { layout: "slides", includeHidden: true, protect: false })

		expect((await openPdf(all.bytes)).numPages).toBe(3)
	})

	it("contains an edit that was never saved", { timeout: 60_000 }, async () => {
		const context = await openDeck(deck())
		const slide = context.session.deck.slides[0] as ShapeRef["slide"]
		const result = await editCapability.command(context, {
			family: "text",
			kind: "setText",
			target: { slide, id: 2 },
			body: { bodyPr: {}, paragraphs: [{ pPr: {}, runs: [{ kind: "r", text: "Edited before saving", rPr: {} }] }] }
		})

		expect(result.ok).toBe(true)

		const pdf = await openPdf((await job(context, "pdf", { layout: "slides", includeHidden: false, protect: false })).bytes)

		expect((await pageText(pdf, 1)).replace(/\s+/gu, " ")).toContain("Edited before saving")
	})

	it("writes a notes page per slide, the slide's notes on it", { timeout: 60_000 }, async () => {
		const context = await openDeck(deck())
		const pdf = await openPdf((await job(context, "pdf", { layout: "notes", includeHidden: false, protect: false })).bytes)

		expect(pdf.numPages).toBe(2)

		const [width, height] = (await pdf.getPage(1)).view.slice(2)

		// The notes size, portrait.
		expect(height).toBeGreaterThan(width ?? Number.POSITIVE_INFINITY)
		expect((await pageText(pdf, 1)).replace(/\s+/gu, " ")).toContain("Greet the room")
		expect((await pageText(pdf, 1)).replace(/\s+/gu, " ")).toContain("Opening")
	})

	it("writes handouts as ceil(N / k) pages", { timeout: 60_000 }, async () => {
		const context = await openDeck(deck())
		const pdf = await openPdf(
			(await job(context, "pdf", { layout: "handouts", perPage: 2, includeHidden: true, protect: false })).bytes
		)

		expect(pdf.numPages).toBe(2)
	})

	it("refuses to protect a PDF of a deck that opened without a password", { timeout: 60_000 }, async () => {
		const context = await openDeck(deck())
		const { outcome, bytes } = await job(context, "pdf", { layout: "slides", includeHidden: false, protect: true })

		expect(outcome).toMatchObject({ kind: "refused", reason: "unsupported" })
		expect(bytes.length).toBe(0)
	})

	const PROTECTED = join(CORPUS_DIR, "pptx", "tika__testPPT_protected_passtika.pptx")
	// Opt-in: FILEN_OFFICE_PDF_TOOLS=<dir> holding qpdf/bin/qpdf.
	const QPDF = join(process.env["FILEN_OFFICE_PDF_TOOLS"] ?? "", "qpdf", "bin", "qpdf")

	it.skipIf(!existsSync(PROTECTED))("protects a password-protected deck's PDF with its own password", { timeout: 60_000 }, async () => {
		const context = await openDeck(new Uint8Array(readFileSync(PROTECTED)), "tika")
		const { outcome, bytes } = await job(context, "pdf", { layout: "slides", includeHidden: false, protect: true })

		expect(outcome).toMatchObject({ kind: "done" })
		await expect(openPdf(bytes)).rejects.toThrow()
		expect((await openPdf(bytes, "tika")).numPages).toBe(context.session.deck.slides.length)

		if (process.env["FILEN_OFFICE_PDF_TOOLS"] !== undefined && existsSync(QPDF)) {
			const dir = mkdtempSync(join(tmpdir(), "pptx-pdf-"))

			try {
				writeFileSync(join(dir, "out.pdf"), bytes)
				expect(execFileSync(QPDF, ["--show-encryption", "--password=tika", join(dir, "out.pdf")]).toString()).toMatch(/R = 6/u)
			} finally {
				rmSync(dir, { recursive: true, force: true })
			}
		}
	})

	it("refuses images where the realm has no canvas", { timeout: 60_000 }, async () => {
		const context = await openDeck(deck())
		const { outcome } = await job(context, "raster", { format: "png", widthPx: 640, zip: true })

		expect(outcome).toMatchObject({ kind: "refused", reason: "notImplemented" })
	})
})

describe("slide images through the jobs worker", () => {
	// A canvas that draws nothing and encodes to its own size (the browsers draw; the harness checks their pixels).
	const inert: unknown = new Proxy(function inertCall() {}, {
		get: (_target, key) => (key === Symbol.toPrimitive ? () => 0 : inert),
		apply: () => inert,
		set: () => true
	})
	const canvas = {
		canvas: (width: number, height: number) => ({
			width,
			height,
			close: () => undefined,
			getContext: () => inert,
			transferToImageBitmap: () => ({ width, height, close: () => undefined }),
			convertToBlob: (options: { type: string }) =>
				Promise.resolve({
					arrayBuffer: () =>
						Promise.resolve(new TextEncoder().encode(`${options.type} ${String(width)}x${String(height)}`).buffer)
				})
		}),
		decode: () => Promise.resolve(undefined),
		copy: () => Promise.resolve(undefined),
		fontsReady: () => Promise.resolve()
	}

	function imageWorker(): PresentationJobsWorkerLike {
		const toPage = new Set<(event: { readonly data: unknown }) => void>()
		const toWorker = new Set<(event: { readonly data: unknown }) => void>()
		const deliver = (listeners: Set<(event: { readonly data: unknown }) => void>, data: unknown): void => {
			void Promise.resolve().then(() => {
				for (const listener of listeners) listener({ data })
			})
		}
		const stop = servePresentationJobsWorker(
			{
				postMessage: message => {
					deliver(toPage, message)
				},
				addEventListener: (_type, listener) => toWorker.add(listener),
				removeEventListener: (_type, listener) => toWorker.delete(listener)
			},
			{ assets: pdfAssets, canvas: canvas as never }
		)

		return {
			postMessage: message => {
				deliver(toWorker, message)
			},
			addEventListener: (_type, listener) => toPage.add(listener),
			terminate: stop
		}
	}

	it("zips every slide as Slide<n>.png at the width asked, stored", { timeout: 60_000 }, async () => {
		const context = await openDeck(deck())
		const handle = presentationJobsClient(imageWorker)(
			"raster",
			{ format: "png", widthPx: 1920, zip: true },
			{
				jobsPort: port => {
					serveJobsPort(context, port as JobsPortEnd)

					return Promise.resolve()
				}
			}
		)
		const chunks: number[] = []

		for (let chunk = await handle.output.read(); chunk !== undefined; chunk = await handle.output.read()) chunks.push(...chunk)

		expect(await handle.done).toMatchObject({ kind: "done", contentType: "application/zip" })
		handle.close()

		const zip = new TextDecoder("latin1").decode(Uint8Array.from(chunks))

		expect([...zip.matchAll(/Slide(\d)\.png/gu)].map(match => match[1])).toEqual(["1", "2", "3", "1", "2", "3"])
		// 9144000 x 5143500 EMU at 1920 px wide.
		expect(zip).toContain("image/png 1920x1080")
	})

	it("writes the current slide alone as one image", { timeout: 60_000 }, async () => {
		const context = await openDeck(deck())
		const slide = context.session.deck.slides[2] as ShapeRef["slide"]
		const handle = presentationJobsClient(imageWorker)(
			"raster",
			{ format: "jpeg", widthPx: 640, zip: false, slides: [slide] },
			{
				jobsPort: port => {
					serveJobsPort(context, port as JobsPortEnd)

					return Promise.resolve()
				}
			}
		)
		const chunks: number[] = []

		for (let chunk = await handle.output.read(); chunk !== undefined; chunk = await handle.output.read()) chunks.push(...chunk)

		expect(await handle.done).toMatchObject({ kind: "done", contentType: "image/jpeg" })
		handle.close()
		expect(new TextDecoder().decode(Uint8Array.from(chunks))).toBe("image/jpeg 640x360")
	})
})

const SVG = new TextEncoder().encode(
	'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20"><rect width="20" height="20" fill="red"/></svg>'
)

// A deck whose one picture is an SVG without a raster fallback, 200 x 150 px on the slide.
function svgDeck(): Uint8Array {
	const picture =
		'<p:pic><p:nvPicPr><p:cNvPr id="5" name="Picture 5" descr="A red square"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr>' +
		'<p:blipFill><a:blip r:embed="rId9"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>' +
		`<p:spPr>${xfrm(600 * EMU, 300 * EMU, 200 * EMU, 150 * EMU)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>`

	return buildPptx({
		slides: [{ shapes: picture, rels: [["rId9", "image", "../media/image1.svg"]] }],
		parts: { "ppt/media/image1.svg": { data: SVG, type: "image/svg+xml" } }
	})
}

// A canvas whose SVG rasters are opaque red, read back as RGBA.
function redCanvas(svg: RealmCanvas["svg"]): RealmCanvas {
	return {
		canvas: (width, height) =>
			({
				width,
				height,
				close: () => undefined,
				getContext: () => ({
					drawImage: () => undefined,
					getImageData: (_x: number, _y: number, w: number, h: number) => {
						const data = new Uint8ClampedArray(w * h * 4)

						for (let k = 0; k < data.length; k += 4) data.set([255, 0, 0, 255], k)

						return { width: w, height: h, data }
					}
				}),
				transferToImageBitmap: () => ({ width, height, close: () => undefined })
			}) as never,
		...(svg === undefined ? {} : { svg }),
		decode: () => Promise.resolve(undefined),
		copy: () => Promise.resolve(undefined),
		fontsReady: () => Promise.resolve()
	}
}

async function openOdp(bytes: Uint8Array): Promise<CallContext> {
	const options = { format: "odp" as const, fileName: "Untitled deck.odp" }
	const outcome = await openOdpCapability.open({ source: bytesSource(bytes), sourceKind: "bytes", options })

	if (outcome.kind !== "opened") throw new Error(outcome.kind)

	const session: EngineSession = {
		s: 1,
		deck: outcome.deck,
		package: outcome.package,
		options,
		services: { ...SERVICES, text: presentationTextServices },
		rangeSource: undefined,
		schedule: () => undefined,
		emit: () => undefined,
		onClose: () => undefined
	}

	return {
		session,
		signal: { aborted: false, onAbort: () => undefined },
		lane: "background",
		slicing: { pause: () => Promise.resolve(), sliceMs: 50, now: () => Date.now() }
	}
}

describe("what a PDF job tells the page", () => {
	it("writes the same PDF bytes twice when the page asks for deterministic output", { timeout: 60_000 }, async () => {
		const context = await openDeck(deck())
		const request = { layout: "slides", includeHidden: true, protect: false, deterministic: true } as const
		const first = await job(context, "pdf", request)
		const second = await job(context, "pdf", request)

		expect(first.outcome.kind).toBe("done")
		expect(Buffer.from(first.bytes).equals(Buffer.from(second.bytes))).toBe(true)
	})

	it("reports an SVG picture it could not draw as content left out", { timeout: 60_000 }, async () => {
		const context = await openDeck(svgDeck())
		const { outcome } = await job(context, "pdf", { layout: "slides", includeHidden: true, protect: false })

		expect(outcome).toMatchObject({ kind: "done", pdf: { refused: [["untranslated", 1]] } })
	})

	it("draws an SVG picture through the page's rasteriser at twice the size it lands at", { timeout: 60_000 }, async () => {
		const context = await openDeck(svgDeck())
		const asked: number[] = []
		const rasterize: SvgRasterizer = (_bytes, side) => {
			asked.push(side)

			return Promise.resolve(undefined)
		}
		const client = presentationJobsClient(() => inThreadJobsWorker(redCanvas(undefined)), { svg: rasterize })
		const { outcome } = await job(context, "pdf", { layout: "slides", includeHidden: true, protect: false }, client)

		// The page was asked over the worker's SVG port (200 px landed, x2, in 128 px steps); it drew nothing here, so
		// the picture is reported.
		expect(asked).toEqual([512])
		expect(outcome).toMatchObject({ kind: "done", pdf: { refused: [["untranslated", 1]] } })
	})

	it("refuses with the password reason when the deck's password cannot protect a PDF", { timeout: 60_000 }, async () => {
		// Mixed text directions: SASLprep prohibits the password (ISO 32000-2 7.6.4.3.3).
		const password = "abc\u05d0"
		const context = await openDeck(await encryptedOfficeFile(agileStreams(deck(), password)), password)
		const { outcome } = await job(context, "pdf", { layout: "slides", includeHidden: true, protect: true })

		expect(outcome).toMatchObject({ kind: "refused", reason: "unsupported" })
		expect(outcome.kind === "refused" ? outcome.detail : "").toMatch(/^password/u)
	})

	it("titles an OpenDocument deck's PDF with its meta.xml title", { timeout: 60_000 }, async () => {
		const meta =
			'<?xml version="1.0" encoding="UTF-8"?><office:document-meta xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" ' +
			'xmlns:dc="http://purl.org/dc/elements/1.1/" office:version="1.3"><office:meta><dc:title>  Alizarin\n crimson </dc:title></office:meta></office:document-meta>'
		const context = await openOdp(
			odpBytes({
				body: page(
					'<draw:frame svg:x="2cm" svg:y="2cm" svg:width="10cm" svg:height="2cm"><draw:text-box><text:p>Hi</text:p></draw:text-box></draw:frame>'
				),
				masters: DEFAULT_MASTER,
				extra: [{ name: "meta.xml", data: new TextEncoder().encode(meta), mediaType: "text/xml" }]
			})
		)
		const { bytes } = await job(context, "pdf", { layout: "slides", includeHidden: true, protect: false })
		const metadata = await (await openPdf(bytes)).getMetadata()

		expect((metadata.info as { Title?: string }).Title).toBe("Alizarin crimson")
	})

	it("carries a deck's core properties into its PDF as PowerPoint's Save as PDF does", { timeout: 60_000 }, async () => {
		const core =
			'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" ' +
			'xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Deck</dc:title><dc:creator>Cora</dc:creator><dc:subject>Rivers</dc:subject>' +
			"<cp:keywords>delta, flow</cp:keywords></cp:coreProperties>"
		const context = await openDeck(
			buildPptx({
				slides: [{ shapes: sp(2, "Title 1", 'type="title"', xfrm(100 * EMU, 40 * EMU, 760 * EMU, 80 * EMU), body(para("Hi"))) }],
				parts: { "docProps/core.xml": { data: core, type: "application/vnd.openxmlformats-package.core-properties+xml" } },
				packageRels: [
					[
						"rIdCore",
						"http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties",
						"docProps/core.xml"
					]
				]
			})
		)
		const { bytes } = await job(context, "pdf", { layout: "slides", includeHidden: true, protect: false })
		const metadata = await (await openPdf(bytes)).getMetadata()

		expect(metadata.info).toMatchObject({ Title: "Deck", Author: "Cora", Subject: "Rivers", Keywords: "delta, flow" })
		expect(metadata.metadata?.get("pdf:keywords")).toBe("delta, flow")
	})
})

describe("SVG pictures in a jobs worker", () => {
	it("asks the page for an SVG's raster over the port the page posted", async () => {
		const listeners = new Set<(event: { readonly data: unknown }) => void>()
		const stop = servePresentationJobsWorker(
			{
				postMessage: () => undefined,
				addEventListener: (_type, listener) => listeners.add(listener),
				removeEventListener: (_type, listener) => listeners.delete(listener)
			},
			{ assets: pdfAssets, canvas: redCanvas(undefined) }
		)
		const sent: { id: number; bytes: Uint8Array; maxSide: number }[] = []
		const port = {
			onmessage: null as ((event: { readonly data: unknown }) => void) | null,
			postMessage: (message: unknown) => {
				sent.push(message as (typeof sent)[number])
			},
			close: () => undefined
		}

		try {
			for (const listener of listeners) listener({ data: { t: "svgPort", port } })

			const raster = presentationJobsRealm()?.canvas?.svg?.(SVG, 300)
			const bitmap = { width: 300, height: 300, close: () => undefined }

			expect(sent).toMatchObject([{ maxSide: 300 }])
			port.onmessage?.({ data: { id: sent[0]?.id, bitmap } })
			expect(await raster).toBe(bitmap)
		} finally {
			stop()
		}
	})
})
