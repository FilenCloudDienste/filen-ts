import { vi } from "vitest"
import type { HeicDecoderModule, HeicTransformDeps } from "@/features/preview/lib/heicCodec"

interface FakeImageTarget {
	width: number
	height: number
	data: Uint8ClampedArray
}

interface FakeHeicImage {
	get_width: () => number
	get_height: () => number
	display: (target: FakeImageTarget, callback: (result: unknown) => void) => void
	free: () => void
}

// A libheif-shaped fake: HeifDecoder.decode() returns `imageCount` fake images (each `width`x`height`),
// display() invoking its callback with `displayResult` — {} simulates a real fill; null/undefined
// mirror libheif's own "decode failed" callback signal. Tracks free()/heif_context_free() calls so
// decodeHeic's cleanup-on-every-path behavior (its finally block) is independently verifiable.
export function fakeLib(
	options: { width?: number; height?: number; displayResult?: unknown; decodeThrows?: unknown; imageCount?: number } = {}
): {
	lib: HeicDecoderModule
	freeCalls: number[]
	contextFreeCalls: unknown[]
} {
	const { width = 2, height = 2, decodeThrows, imageCount = 1 } = options
	// A destructured default (`displayResult = {}`) would also fire for an explicit
	// `{ displayResult: undefined }` — one of the exact failure signals under test — so presence is
	// checked separately instead.
	const displayResult = "displayResult" in options ? options.displayResult : {}
	const freeCalls: number[] = []
	const contextFreeCalls: unknown[] = []

	class HeifDecoder {
		decoder: unknown = true

		decode(): FakeHeicImage[] {
			if (decodeThrows !== undefined) {
				// eslint-disable-next-line @typescript-eslint/only-throw-error -- deliberately a non-Error throw, mirroring decode()'s real WASM-trap failure shape
				throw decodeThrows
			}

			return Array.from({ length: imageCount }, (_, index) => ({
				get_width: () => width,
				get_height: () => height,
				display: (target: FakeImageTarget, callback: (result: unknown) => void) => {
					target.data.fill(128)
					callback(displayResult)
				},
				free: () => {
					freeCalls.push(index)
				}
			}))
		}
	}

	const lib: HeicDecoderModule = {
		HeifDecoder,
		heif_context_free: context => {
			contextFreeCalls.push(context)
		}
	}

	return { lib, freeCalls, contextFreeCalls }
}

export function depsFor(lib: HeicDecoderModule, encodeJpeg?: HeicTransformDeps["encodeJpeg"]) {
	const getDecoderSpy = vi.fn(() => Promise.resolve(lib))
	const deps: HeicTransformDeps = {
		getDecoder: getDecoderSpy,
		encodeJpeg: encodeJpeg ?? (() => Promise.resolve(new Blob(["jpeg"], { type: "image/jpeg" })))
	}

	return { deps, getDecoderSpy }
}
