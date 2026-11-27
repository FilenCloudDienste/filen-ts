// The service worker's pass-through of an inline response body that copies out its first bytes (SW_MSG_PREVIEW_HEAD).
// Split out of sw.ts so it is unit-testable.

// `source` read only as the consumer reads it (no high-water mark). Its first `limit` bytes, or all of them if it ends
// sooner, are copied as they pass and handed to `onHead` once; a body cancelled or failed before then hands nothing.
export function headTap(
	source: ReadableStream<Uint8Array>,
	limit: number,
	onHead: (head: Uint8Array<ArrayBuffer>) => void
): ReadableStream<Uint8Array> {
	const reader = source.getReader()
	let head: Uint8Array<ArrayBuffer> | null = new Uint8Array(limit)
	let filled = 0

	function hand(): void {
		if (head !== null) {
			const out = filled === head.length ? head : head.slice(0, filled)

			head = null
			onHead(out)
		}
	}

	return new ReadableStream<Uint8Array>(
		{
			start() {
				if (limit === 0) {
					hand()
				}
			},
			async pull(controller) {
				const { done, value } = await reader.read()

				if (done) {
					hand()
					controller.close()

					return
				}

				if (head !== null) {
					const take = Math.min(value.byteLength, head.length - filled)

					head.set(value.subarray(0, take), filled)
					filled += take

					if (filled === head.length) {
						hand()
					}
				}

				controller.enqueue(value)
			},
			cancel(reason) {
				head = null

				return reader.cancel(reason)
			}
		},
		{ highWaterMark: 0 }
	)
}
