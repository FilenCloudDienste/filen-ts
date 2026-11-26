import { animatedImageType } from "@/features/preview/lib/animatedImage.logic"

// Opens an animated image for the preview's player: WebCodecs' ImageDecoder over the bytes already held, or over the
// one download of the image's stream, read until its head says whether it animates. A still image (or a type this
// browser's ImageDecoder does not take) is left to the plain <img>.

// Where every header the animation sniff reads sits.
const HEAD_BYTES = 64 * 1024

export interface AnimationSource {
	readonly decoder: ImageDecoder
	// Frame 0, decoded before the player replaces the <img>; whoever draws it closes it.
	readonly first: VideoFrame
}

export function imageDecoderAvailable(): boolean {
	return "ImageDecoder" in globalThis
}

const supported = new Map<string, Promise<boolean>>()

function decoderSupports(type: string): Promise<boolean> {
	let answer = supported.get(type)

	if (answer === undefined) {
		answer = ImageDecoder.isTypeSupported(type).catch(() => false)
		supported.set(type, answer)
	}

	return answer
}

interface Head {
	readonly bytes: Uint8Array
	readonly done: boolean
}

async function readHead(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<Head> {
	const chunks: Uint8Array[] = []
	let length = 0

	while (length < HEAD_BYTES) {
		const { done, value } = await reader.read()

		if (done) {
			return { bytes: concat(chunks, length), done: true }
		}

		chunks.push(value)
		length += value.byteLength
	}

	return { bytes: concat(chunks, length), done: false }
}

function concat(chunks: readonly Uint8Array[], length: number): Uint8Array {
	if (chunks.length === 1 && chunks[0] !== undefined) {
		return chunks[0]
	}

	const out = new Uint8Array(length)
	let at = 0

	for (const chunk of chunks) {
		out.set(chunk, at)
		at += chunk.byteLength
	}

	return out
}

// The head first, then the rest of the response as the decoder pulls it.
function resumedStream(head: Head, reader: ReadableStreamDefaultReader<Uint8Array>): ReadableStream<Uint8Array> {
	return new ReadableStream<Uint8Array>({
		start: controller => {
			controller.enqueue(head.bytes)

			if (head.done) {
				controller.close()
			}
		},
		pull: async controller => {
			const { done, value } = await reader.read()

			if (done) {
				controller.close()
			} else {
				controller.enqueue(value)
			}
		},
		cancel: async reason => {
			await reader.cancel(reason)
		}
	})
}

async function startDecoder(data: ImageBufferSource, type: string, signal: AbortSignal): Promise<AnimationSource | null> {
	const decoder = new ImageDecoder({ data, type, preferAnimation: true })
	const close = (): void => {
		decoder.close()
	}

	signal.addEventListener("abort", close, { once: true })

	try {
		await decoder.tracks.ready

		if (decoder.tracks.selectedTrack?.animated !== true) {
			decoder.close()

			return null
		}

		const { image } = await decoder.decode({ frameIndex: 0 })

		if (signal.aborted) {
			image.close()

			return null
		}

		return { decoder, first: image }
	} catch (error) {
		decoder.close()

		if (signal.aborted) {
			return null
		}

		throw error
	} finally {
		signal.removeEventListener("abort", close)
	}
}

// `held`: the file's whole bytes when already in memory (the decoder copies them). `url`: the image's same-origin
// stream URL otherwise; a blob: URL is never fetched (the CSP's connect-src refuses it). Aborting `signal` closes
// the decoder and stops the download; after a resolution the caller owns both and closes the decoder itself.
export async function openAnimation(
	held: Uint8Array | undefined,
	url: string,
	totalSize: number,
	signal: AbortSignal
): Promise<AnimationSource | null> {
	if (held !== undefined) {
		const type = animatedImageType(held, held.byteLength)

		return type === null || !(await decoderSupports(type)) || signal.aborted ? null : await startDecoder(held, type, signal)
	}

	if (url.startsWith("blob:")) {
		return null
	}

	const response = await fetch(url, { signal })
	const body = response.body

	if (!response.ok || body === null) {
		await body?.cancel().catch(() => undefined)

		return null
	}

	const reader = body.getReader()
	const head = await readHead(reader)
	const type = animatedImageType(head.bytes, totalSize)

	if (type === null || !(await decoderSupports(type)) || signal.aborted) {
		await reader.cancel().catch(() => undefined)

		return null
	}

	// A decoder that declines (or fails) stops the download here too, whether or not closing it cancels its stream.
	const source = await startDecoder(resumedStream(head, reader), type, signal).catch(async (error: unknown) => {
		await reader.cancel().catch(() => undefined)

		throw error
	})

	if (source === null) {
		await reader.cancel().catch(() => undefined)
	}

	return source
}
