import { animatedImageType } from "@/features/preview/lib/animatedImage.logic"
import { previewStreamHead, previewStreamIdOf } from "@/features/preview/lib/previewStream"
import { SW_DOWNLOAD_PREFIX } from "@/lib/sw/protocol"

// Opens an animated image for the preview's player: WebCodecs' ImageDecoder over the bytes already held, or over a
// download of the image's stream once the head its <img> read says it animates. A still image (or a type this
// browser's ImageDecoder does not take) is left to the plain <img>.

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

// The response's body as the decoder pulls it, through a reader this keeps: a decoder that declines or fails leaves
// the download to be stopped here, whether or not closing it cancels its stream.
function relayed(reader: ReadableStreamDefaultReader<Uint8Array>): ReadableStream<Uint8Array> {
	return new ReadableStream<Uint8Array>({
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

// The animation type of each stream id whose head was read, so a revisit the browser answers from its memory cache
// (no response, so no head) still knows. Bounded; a type string or null each.
const verdicts = new Map<string, string | null>()
const MAX_VERDICTS = 64

function rememberVerdict(id: string, type: string | null): void {
	verdicts.delete(id)
	verdicts.set(id, type)

	if (verdicts.size > MAX_VERDICTS) {
		const oldest = verdicts.keys().next().value

		if (oldest !== undefined) {
			verdicts.delete(oldest)
		}
	}
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

// `held`: the file's whole bytes when already in memory (the decoder copies them). `url`: the image's service worker
// stream URL otherwise, whose head the worker hands over from the <img>'s own response (previewStreamHead): a still
// costs no read beyond the <img>'s, and only an animation is fetched again, for the decoder. A blob: URL is never
// fetched (the CSP's connect-src refuses it). Aborting `signal` closes the decoder and stops the download; after a
// resolution the caller owns both and closes the decoder itself.
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

	if (!url.startsWith(SW_DOWNLOAD_PREFIX)) {
		return null
	}

	const id = previewStreamIdOf(url)
	let type = verdicts.get(id)

	if (type === undefined) {
		const head = await previewStreamHead(id, signal)

		if (head === null) {
			return null
		}

		type = animatedImageType(head, totalSize)
		rememberVerdict(id, type)
	}

	if (type === null || !(await decoderSupports(type)) || signal.aborted) {
		return null
	}

	const response = await fetch(url, { signal })
	const body = response.body

	if (!response.ok || body === null) {
		await body?.cancel().catch(() => undefined)

		return null
	}

	const reader = body.getReader()
	const source = await startDecoder(relayed(reader), type, signal).catch(async (error: unknown) => {
		await reader.cancel().catch(() => undefined)

		throw error
	})

	if (source === null) {
		await reader.cancel().catch(() => undefined)
	}

	return source
}
