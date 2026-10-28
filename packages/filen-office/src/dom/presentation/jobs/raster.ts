import { refused, type SlideRef } from "../../../core/presentation/model"
import { presentationJobsRealm, registerFaces, slideImage, slideImageName, writeImageZip, type RasterFormat } from "../raster"
import type { JobContext, JobDefinition } from "./registry"

// PNG or JPEG images of slides at a chosen width: one image as it is, several as a stored zip ("Slide<n>.png" by the
// slide's place in the deck), each slide rendered, painted, encoded and written before the next is read.

async function imageOf(
	context: JobContext,
	ref: SlideRef,
	options: {
		readonly format: RasterFormat
		readonly widthPx: number
		readonly quality?: number
		readonly size: { cx: number; cy: number }
	}
): Promise<Uint8Array> {
	const realm = presentationJobsRealm()
	const canvas = realm?.canvas
	const session = context.session

	if (canvas === undefined) throw new Error("no canvas in this realm")

	const [render] = await session.render([ref])

	if (render === undefined) throw new Error("the slide did not render")

	const image = session.image
	const bytes = await slideImage(render, {
		canvas,
		size: options.size,
		widthPx: options.widthPx,
		format: options.format,
		...(options.quality === undefined ? {} : { quality: options.quality }),
		read: async part => (image === undefined ? null : ((await image(part))?.bytes ?? null))
	})

	if (bytes === undefined) throw new Error("the slide could not be drawn at that size")

	return bytes
}

export const rasterJob: JobDefinition<"raster"> = {
	async run(request, context) {
		const realm = presentationJobsRealm()
		const session = context.session

		if (realm?.canvas === undefined || session.deckInfo === undefined) return refused("notImplemented", "raster job: no canvas")

		const info = await session.deckInfo()
		const order = new Map(info.slides.map((slide, index) => [slide.ref, index]))
		const slides = (request.slides ?? info.slides.map(slide => slide.ref)).filter(ref => order.has(ref))

		if (slides.length === 0) return refused("notFound", "no slides to export")
		if (!request.zip && slides.length !== 1) return refused("unsupported", "several images go in a zip")

		if (realm.fonts !== undefined) await registerFaces(realm.fonts, (await session.faces?.()) ?? [])

		const options = {
			format: request.format,
			widthPx: request.widthPx,
			size: info.size,
			...(request.quality === undefined ? {} : { quality: request.quality })
		}
		const contentType = request.zip ? "application/zip" : request.format === "jpeg" ? "image/jpeg" : "image/png"

		if (!request.zip) {
			const bytes = await imageOf(context, slides[0] as SlideRef, options)

			await context.output.write(bytes)
			await context.output.close()
			context.progress(1, 1)

			return { kind: "done", bytes: bytes.length, contentType }
		}

		let done = 0

		async function* images() {
			for (const ref of slides) {
				if (context.signal.aborted) return

				const bytes = await imageOf(context, ref, options)

				yield { name: slideImageName(order.get(ref) ?? 0, request.format), bytes }
				context.progress(++done, slides.length)
			}
		}

		const size = await writeImageZip(images(), context.output, realm.slicing === undefined ? {} : { slicing: realm.slicing })

		if (context.signal.aborted) return refused("aborted", "raster job")

		return { kind: "done", bytes: size, contentType }
	}
}
