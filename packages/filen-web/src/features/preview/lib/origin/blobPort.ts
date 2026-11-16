import { crc32 } from "@filen/office/core/opc"
import { exposeRangePort } from "@/lib/media/rangePort"
import { registerPreviewDisposer } from "@/lib/workers/previewDisposers"

// A range port the page serves over a Blob it holds (a `bytes` origin), for a reader in a worker or a service-worker
// stream. Lives until its reader closes it, the idle timeout, `lifetime` aborting, or sign-out; the Blob is held only
// as long as the port.
export function serveBlobPort(blob: Blob, lifetime: AbortController = new AbortController()): MessagePort {
	const { port1, port2 } = new MessageChannel()
	const unregister = registerPreviewDisposer("blobPort", () => {
		lifetime.abort()
	})

	lifetime.signal.addEventListener("abort", unregister, { once: true })

	if (lifetime.signal.aborted) {
		unregister()
	}

	exposeRangePort(
		port1,
		async (start, end, signal) => {
			signal.throwIfAborted()

			const bytes = new Uint8Array(await blob.slice(start, end).arrayBuffer())

			signal.throwIfAborted()

			return bytes
		},
		lifetime,
		crc32
	)

	return port2
}
