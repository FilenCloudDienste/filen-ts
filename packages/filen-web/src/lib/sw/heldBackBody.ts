// The service worker's body for a download the page streams in (an archive entry). Split out of sw.ts so
// it is unit-testable.
//
// The latest chunk is held back until the source closes. The page's SDK writes an entry's bytes before
// it checks them, and on a failed check aborts the stream after the last byte. Forwarded at once, the
// body would hold every byte its Content-Length promises before the error arrives, and a browser that
// finishes a download on its length would keep the file; held back, it always ends short. Defense in
// depth: the engines tested fail an errored body either way. It must only ever error, never close short,
// which they save as complete.

export type HeldBackEnd = { type: "done" } | { type: "failed"; error: unknown; cancelledByBrowser: boolean }

export interface HeldBackBody {
	body: ReadableStream<Uint8Array>
	// Settles once: the body closed, failed, or its reader (the browser's download) cancelled it.
	ended: Promise<HeldBackEnd>
	// Fails the body and cancels the source, so the page's writer stops too (the page's own cancel).
	fail: (reason: unknown) => void
}

export function heldBackBody(source: ReadableStream<Uint8Array>): HeldBackBody {
	const reader = source.getReader()
	let held: Uint8Array | null = null
	let control: ReadableStreamDefaultController<Uint8Array> | null = null
	let settled = false
	let settle: (end: HeldBackEnd) => void = () => undefined
	const ended = new Promise<HeldBackEnd>(resolve => {
		settle = resolve
	})

	function finish(end: HeldBackEnd): void {
		held = null

		if (!settled) {
			settled = true
			settle(end)
		}
	}

	const body = new ReadableStream<Uint8Array>(
		{
			start(controller) {
				control = controller
			},
			async pull(controller) {
				try {
					for (;;) {
						const { done, value } = await reader.read()

						if (done) {
							if (held !== null) {
								controller.enqueue(held)
							}

							controller.close()
							finish({ type: "done" })

							return
						}

						const out = held

						held = value

						if (out !== null) {
							controller.enqueue(out)

							return
						}
					}
				} catch (e) {
					finish({ type: "failed", error: e, cancelledByBrowser: false })

					throw e
				}
			},
			cancel(reason) {
				finish({ type: "failed", error: reason, cancelledByBrowser: true })

				return reader.cancel(reason)
			}
		},
		{ highWaterMark: 0 }
	)

	return {
		body,
		ended,
		fail: reason => {
			finish({ type: "failed", error: reason, cancelledByBrowser: false })

			try {
				control?.error(reason)
			} catch {
				// Already closed or errored.
			}

			reader.cancel(reason).catch(() => undefined)
		}
	}
}
