import * as Comlink from "comlink"

// Bridges a worker stream to a main-thread destination: a TransformStream's writable end is transferred
// into the worker (the SDK pushes decrypted bytes into it), its readable end piped to the destination
// here. COORDINATED TEARDOWN: if the worker call rejects (e.g. cancelTransfer aborted it), the SDK may
// leave the transferred writable OPEN, so the pipe is aborted too — otherwise a consumer hangs forever on
// an open-but-abandoned stream; `sinkDone` is swallowed on THIS branch only, since an abort-induced
// rejection is expected. The success path awaits the RAW `sinkDone`, so a genuine close/flush failure
// (disk full at close, a revoked handle) rejects too rather than looking like a finished download.
export async function pipeWorkerToSink(
	destination: WritableStream<Uint8Array>,
	run: (transferred: WritableStream<Uint8Array>) => Promise<void>
): Promise<void> {
	const transform = new TransformStream<Uint8Array, Uint8Array>()
	const teardown = new AbortController()
	const sinkDone = transform.readable.pipeTo(destination, { signal: teardown.signal })

	try {
		await run(Comlink.transfer(transform.writable, [transform.writable]))
	} catch (e) {
		teardown.abort()
		await sinkDone.catch(() => undefined)

		throw e
	}

	await sinkDone
}
