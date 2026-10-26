import type { SavePortReader } from "@filen/office/dom/presentation/savePort"

// The upload's ReadableStream over a save port's reader (the SDK worker builds it locally: no stream crosses between
// workers, which one supported engine cannot do). A byte stream, since the SDK reads with a BYOB reader; every chunk
// came transferred whole, so the stream takes it without a copy. The stream ends only when the writer committed; it
// errors when the writer aborted or the port stalled, and cancelling it aborts the writer.
export function savePortStream(reader: SavePortReader): ReadableStream<Uint8Array> {
	return new ReadableStream({
		type: "bytes",
		async pull(controller) {
			const chunk = await reader.read()

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
