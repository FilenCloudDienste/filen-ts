import { isAbortError } from "@filen/shared"
import type { VideoEditClient, VideoEditRecipe } from "@/features/preview/videoEdit/types"
import { log } from "@/lib/log"

interface FrameRequest {
	time: number
	recipe: VideoEditRecipe
	maxWidth: number
	draw: (bitmap: ImageBitmap) => void
}

// Exact frames from the client, one decode at a time: while one is in flight only the newest request waits, so a
// scrub never queues a frame per pointer move. Every bitmap is drawn by its request's `draw` and closed right after.
export class FrameRequests {
	private running = false
	private pending: FrameRequest | null = null
	private disposed = false

	private readonly client: VideoEditClient

	constructor(client: VideoEditClient) {
		this.client = client
	}

	request(time: number, recipe: VideoEditRecipe, maxWidth: number, draw: (bitmap: ImageBitmap) => void): void {
		// While an export holds the decoder (iOS), nothing is asked: the element's own picture stands in.
		if (this.disposed || this.client.isDecodingSuspended()) {
			return
		}

		this.pending = { time, recipe, maxWidth, draw }
		this.pump()
	}

	// Forgets the waiting request (the playhead moved on to playing).
	clear(): void {
		this.pending = null
	}

	dispose(): void {
		this.disposed = true
		this.pending = null
	}

	private pump(): void {
		const next = this.pending

		if (this.running || next === null) {
			return
		}

		this.pending = null
		this.running = true

		void this.client
			.frameAt(next.time, next.recipe, Math.max(1, Math.round(next.maxWidth)))
			.then(
				bitmap => {
					if (!this.disposed) {
						next.draw(bitmap)
					}

					bitmap.close()
				},
				(error: unknown) => {
					// Superseded, or an export took the decoder meanwhile: nothing went wrong.
					if (!isAbortError(error)) {
						log.warn("[videoEditor] frame failed", error)
					}
				}
			)
			.then(() => {
				this.running = false
				this.pump()
			})
	}
}

// A bitmap drawn whole into a canvas, the canvas sized to it.
export function drawBitmap(canvas: HTMLCanvasElement | null, bitmap: ImageBitmap): void {
	if (canvas === null || bitmap.width === 0) {
		return
	}

	if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
		canvas.width = bitmap.width
		canvas.height = bitmap.height
	}

	canvas.getContext("2d")?.drawImage(bitmap, 0, 0)
}
