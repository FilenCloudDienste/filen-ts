import { sliceClock } from "../../../core/slicing"
import { PresentationError, type SlideRef } from "../../../core/presentation/model"
import type { SlideRender } from "../../../core/presentation/output"
import type { CallContext, EngineSession, ThumbsCapability } from "../engine"
import type { BitmapLike } from "../protocol"
import { presentationRealm, type RasterImage } from "../services"
import { DecodedPictures, MAX_THUMB_WIDTH, MIN_THUMB_WIDTH, ThumbnailCache, rasterizeSlide, type RasterizedSlide } from "../thumbs"
import { readPart, renderSlideFor } from "./view"

// Thumbnails for the rail and the slide sorter: each asked slide rendered, drawn on a canvas at the width asked and
// sent as a bitmap through "thumbs" events, a few at a time, in the order asked (the page asks the visible window
// first). Kept in the session's cache by slide, revision and width (64 MiB, least recently used out); a cached one
// is sent as a copy, so the cache keeps its own. Runs in the background lane, yielding between slides. The slides'
// pictures are decoded once for the session (DecodedPictures), and the next slides are rendered while the pictures
// of the ones before them decode (at most AHEAD in flight).

// Thumbnails per "thumbs" event.
const BATCH = 4
// Slides per request.
const MAX_REFS = 10_000
// Slides rasterising at once (their pictures decode off the worker's thread meanwhile).
const AHEAD = 4

export type RenderSlide = (context: CallContext, ref: SlideRef) => Promise<SlideRender>

const caches = new WeakMap<EngineSession, ThumbnailCache>()
const pictureCaches = new WeakMap<EngineSession, DecodedPictures>()

export function sessionThumbnails(session: EngineSession): ThumbnailCache {
	let cache = caches.get(session)

	if (cache === undefined) {
		const created = new ThumbnailCache()

		caches.set(session, created)
		session.onClose(() => created.clear())
		cache = created
	}

	return cache
}

// The session's decoded pictures, shared by every slide drawn on the canvas path.
export function sessionPictures(session: EngineSession): DecodedPictures {
	let cache = pictureCaches.get(session)

	if (cache === undefined) {
		const created = new DecodedPictures()

		pictureCaches.set(session, created)
		session.onClose(() => created.clear())
		cache = created
	}

	return cache
}

// One slide's thumbnail on its way: from the cache, or rasterising.
interface Pending {
	readonly slide: SlideRef
	revision: number
	readonly cached: RasterImage | undefined
	readonly raster: Promise<RasterizedSlide | undefined> | undefined
}

export function thumbsCapabilityOf(
	render: RenderSlide,
	read: (session: EngineSession, part: string) => Promise<Uint8Array | null>
): ThumbsCapability {
	return {
		async thumbnails(context, refs, widthPx) {
			const realm = presentationRealm()

			if (realm === undefined) throw new PresentationError("notImplemented", "thumbnails need a canvas realm")

			const width = Math.round(widthPx)

			if (!(width >= MIN_THUMB_WIDTH && width <= MAX_THUMB_WIDTH) || refs.length > MAX_REFS)
				throw new PresentationError("tooLarge", "thumbnails")

			const { session, signal } = context
			const known = new Set(session.deck.slides)
			const cache = sessionThumbnails(session)
			const pictures = sessionPictures(session)
			const clock = sliceClock(context.slicing)
			const ahead: Pending[] = []
			let batch: { slide: SlideRef; revision: number; bitmap: BitmapLike }[] = []
			const flush = (): void => {
				if (batch.length === 0) return

				session.emit({ type: "thumbs", items: batch })
				batch = []
			}
			// The oldest one in flight: cached, then copied into the batch.
			const finish = async (): Promise<void> => {
				const next = ahead.shift()

				if (next === undefined) return

				let image = next.cached

				if (image === undefined) {
					const raster = await next.raster

					if (raster === undefined) throw new PresentationError("tooLarge", "thumbnail canvas")

					cache.invalidate(next.slide, next.revision)
					cache.put(ThumbnailCache.key(next.slide, next.revision, width), raster.bitmap)
					image = raster.bitmap
				}

				const copy = await realm.canvas.copy(image)

				if (copy !== undefined) batch.push({ slide: next.slide, revision: next.revision, bitmap: copy })
				if (batch.length >= BATCH) flush()
			}

			try {
				for (const ref of refs) {
					if (signal.aborted) throw new PresentationError("aborted", "thumbnails")
					if (!known.has(ref)) throw new PresentationError("notFound", "slide")

					const node = session.deck.nodes.get(ref)
					const key = node === undefined ? undefined : ThumbnailCache.key(ref, node.revision, width)
					const cached: RasterImage | undefined = key === undefined ? undefined : cache.get(key)

					if (cached !== undefined) {
						ahead.push({ slide: ref, revision: node?.revision ?? 0, cached, raster: undefined })
					} else {
						const slide = await render(context, ref)

						ahead.push({
							slide: ref,
							revision: slide.revision,
							cached: undefined,
							raster: rasterizeSlide(slide, {
								canvas: realm.canvas,
								size: session.deck.size,
								widthPx: width,
								read: part => read(session, part),
								pictures
							})
						})
					}

					if (ahead.length >= AHEAD) await finish()

					if (clock.due) {
						flush()
						await clock.pause()
					}
				}

				while (ahead.length > 0) {
					if (signal.aborted) throw new PresentationError("aborted", "thumbnails")

					await finish()
				}
			} catch (error) {
				for (const item of batch) item.bitmap.close()

				batch = []

				// What is still rasterising is closed as it lands (it never reached the cache).
				for (const pending of ahead.splice(0)) {
					void pending.raster?.then(
						raster => raster?.bitmap.close(),
						() => undefined
					)
				}

				throw error
			}

			flush()
		}
	}
}

export const thumbsCapability: ThumbsCapability = thumbsCapabilityOf(renderSlideFor, readPart)
