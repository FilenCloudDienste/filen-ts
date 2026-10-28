import type { PdfBlobLike, PdfDecodedImage } from "../../../core/pdfwrite/index"
import { refused, type SlideRef } from "../../../core/presentation/model"
import { handoutPage, pageCount, type HandoutsPerPage, type SlideExport } from "../../../core/presentation/pages"
import type { DocxPdfExportReport } from "../../docx/pdfClient"
import { PresentationPdf, type PresentationPdfReport } from "../pdf"
import { presentationJobsRealm, registerFaces, type JobsRealm } from "../raster"
import type { JobDefinition, JobSession } from "./registry"

// PDF of slides (one per page), notes pages (one per slide) or handouts (1, 2, 3, 4, 6 or 9 slides per page), read
// slide by slide from the session (unsaved edits included): at most one handout page of renders is held at a time.
// A protected deck's PDF is encrypted under its password by the key the session makes (the password stays there).

const FALLBACK_LANG = "en"

async function exported(session: JobSession, refs: readonly SlideRef[]): Promise<readonly SlideExport[]> {
	if (session.exportSlides !== undefined) return session.exportSlides(refs)

	// A session without layer kinds: every layer tagged as content.
	return (await session.render(refs)).map(render => ({ render, kinds: render.layers.map(() => "content" as const) }))
}

// An SVG picture drawn by the realm (on the page, through an <img>) and read back as straight RGBA for the PDF.
async function svgPixels(realm: JobsRealm, session: JobSession, part: string, side: number): Promise<PdfDecodedImage | undefined> {
	const canvas = realm.canvas
	const found = canvas?.svg === undefined || session.image === undefined ? null : await session.image(part)

	if (canvas?.svg === undefined || found === null) return undefined

	const bitmap = await canvas.svg(found.bytes, side)

	if (bitmap === undefined) return undefined

	try {
		const context = canvas.canvas(bitmap.width, bitmap.height)?.getContext("2d") ?? null

		if (context === null) return undefined

		context.drawImage(bitmap, 0, 0, bitmap.width, bitmap.height)

		const data = context.getImageData(0, 0, bitmap.width, bitmap.height).data

		return { width: bitmap.width, height: bitmap.height, rgba: new Uint8Array(data.buffer, data.byteOffset, data.byteLength) }
	} catch {
		// A raster the engine marked unreadable (an SVG it taints).
		return undefined
	} finally {
		bitmap.close()
	}
}

// The PDF's report as the Word document's export gives it: a picture left out is content the pages lack.
function reportOf(report: PresentationPdfReport): DocxPdfExportReport {
	const refused = new Map<DocxPdfExportReport["refused"][number][0], number>()

	for (const [kind, count] of report.refused) {
		const as = kind === "picture" ? "untranslated" : kind

		refused.set(as, (refused.get(as) ?? 0) + count)
	}

	return { missing: [...report.missing], refused: [...refused] }
}

async function bytesOf(part: Uint8Array | PdfBlobLike): Promise<Uint8Array> {
	return part instanceof Uint8Array ? part : new Uint8Array(await part.arrayBuffer())
}

export const pdfJob: JobDefinition<"pdf"> = {
	async run(request, context) {
		const realm = presentationJobsRealm()
		const session = context.session

		if (realm === undefined || session.deckInfo === undefined) return refused("notImplemented", "pdf job: no jobs realm")

		const info = await session.deckInfo()
		const wanted = request.slides === undefined ? undefined : new Set(request.slides)
		const slides = info.slides
			.filter(slide => (wanted === undefined ? request.includeHidden || !slide.hidden : wanted.has(slide.ref)))
			.map(slide => slide.ref)

		if (slides.length === 0) return refused("notFound", "no slides to export")

		const perPage: HandoutsPerPage = request.layout === "handouts" ? (request.perPage ?? 6) : 1
		const geometry = request.layout === "handouts" ? handoutPage(perPage, info.size, info.notesSize) : undefined

		if (request.layout === "notes" && session.notesPage === undefined) return refused("notImplemented", "notes pages")

		const securityKey = request.protect ? await session.pdfSecurity?.() : undefined

		if (request.protect && securityKey === undefined) return refused("unsupported", "the deck has no password to protect the PDF with")

		const faces = (await session.faces?.()) ?? []

		if (realm.fonts !== undefined) await registerFaces(realm.fonts, faces)

		const image = session.image
		const pdf = await PresentationPdf.create(
			{
				assets: realm.assets,
				title: info.title ?? request.title ?? "",
				lang: info.lang ?? request.lang ?? realm.lang ?? FALLBACK_LANG,
				signal: context.signal,
				deterministic: request.deterministic === true,
				...(securityKey === undefined ? {} : { securityKey }),
				...(realm.slicing === undefined ? {} : { slicing: realm.slicing }),
				...(realm.deflate === undefined ? {} : { deflate: realm.deflate }),
				...(realm.decoder === undefined ? {} : { decoder: realm.decoder })
			},
			{
				faces,
				image: part => (image === undefined ? Promise.resolve(null) : image(part)),
				...(realm.canvas?.svg === undefined ? {} : { svg: (part: string, side: number) => svgPixels(realm, session, part, side) })
			}
		)

		try {
			const total = pageCount(slides.length, perPage)

			pdf.declareSlides(slides, index =>
				geometry === undefined
					? { page: index, y: 0 }
					: { page: Math.floor(index / perPage), y: geometry.slides[index % perPage]?.y ?? 0 }
			)

			for (let page = 0; page < total; page++) {
				if (context.signal.aborted) return refused("aborted", "pdf job")

				const refs = slides.slice(page * perPage, (page + 1) * perPage)
				const renders = await exported(session, refs)

				if (geometry !== undefined) {
					await pdf.handoutPage(geometry, renders)
				} else if (request.layout === "notes" && session.notesPage !== undefined) {
					const slide = renders[0]

					if (slide !== undefined) await pdf.notesPage(await session.notesPage(slide.render.ref), slide)
				} else {
					for (const slide of renders) await pdf.slidePage(slide)
				}

				context.progress(page + 1, total)
			}

			const result = await pdf.finish()

			for (const part of result.parts) await context.output.write(await bytesOf(part))

			await context.output.close()

			return { kind: "done", bytes: result.size, contentType: "application/pdf", pdf: reportOf(result.report) }
		} finally {
			pdf.close()
		}
	}
}
