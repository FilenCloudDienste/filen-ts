// A gzipped SVG inflated with the browser's own gzip (DecompressionStream), stopped once it passes `maxBytes`: a few
// kilobytes can inflate to gigabytes, so nothing past the cap is ever held. Null when it is larger; rejects for bytes
// that are no gzip stream.
export async function gunzipSvg(bytes: Uint8Array, maxBytes: number): Promise<Blob | null> {
	const reader = new Blob([bytes as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new DecompressionStream("gzip")).getReader()
	const chunks: Uint8Array<ArrayBuffer>[] = []
	let total = 0

	for (;;) {
		const { done, value } = await reader.read()

		if (done) {
			return new Blob(chunks, { type: "image/svg+xml" })
		}

		total += value.byteLength

		if (total > maxBytes) {
			await reader.cancel()

			return null
		}

		chunks.push(value)
	}
}
