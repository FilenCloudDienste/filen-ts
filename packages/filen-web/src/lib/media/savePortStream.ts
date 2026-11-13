import type { SavePortReader } from "@filen/shared/savePort"

export interface SavePortStreamOptions {
	// Called with the reader's failure (the writer aborted, the port stalled) before the stream errors: the upload's
	// abort goes here, so an upload never takes an errored stream for its end and finalizes a truncated file.
	beforeError?: (error: unknown) => void
}

// The upload's ReadableStream over a save port's reader (the SDK worker builds it locally: no stream crosses between
// workers, which one supported engine cannot do). A byte stream, since the SDK reads with a BYOB reader; every chunk
// came transferred whole, so the stream takes it without a copy. The stream ends only when the writer committed; it
// errors when the writer aborted or the port stalled (after `beforeError`), and cancelling it aborts the writer.
export function savePortStream(reader: SavePortReader, options: SavePortStreamOptions = {}): ReadableStream<Uint8Array> {
	return new ReadableStream({
		type: "bytes",
		async pull(controller) {
			let chunk: Uint8Array | undefined

			try {
				chunk = await reader.read()
			} catch (error) {
				options.beforeError?.(error)

				throw error
			}

			if (chunk === undefined) {
				controller.close()
				// A BYOB read waiting on the end only settles once its request is answered with nothing.
				controller.byobRequest?.respond(0)

				return
			}

			// Transferred over the port: a whole ArrayBuffer of its own, never shared.
			controller.enqueue(chunk as Uint8Array<ArrayBuffer>)
		},
		cancel() {
			reader.abort("upload")
		}
	})
}
