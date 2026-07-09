import { describe, expect, it, vi } from "vitest"
import * as Comlink from "comlink"
import type { DecodedHeicImage, HeicDecoderModule, HeicTransformDeps } from "@/features/preview/lib/heicCodec"
import type { HeicWorkerApi } from "@/features/preview/workers/heic.worker"

// heic.worker.ts can't be imported directly here: Comlink.expose(api) runs at module load against
// `self`, which only exists in a real worker (verified: Node has no global `self`). This rebuilds the
// exact one-method api shape heic.worker.ts exposes — HeicWorkerApi is imported as a type only, so this
// never actually evaluates that module — and wires it up over a real MessagePort pair instead. Node's
// MessageChannel is a spec-compliant implementation (not a mock of one), so a call through `remote`
// below is a genuine postMessage round trip. That's the one thing heic-codec.test.ts's in-process tests
// can't prove: that a value runHeicTransform throws still arrives at the caller as a clean Error after
// actually crossing a worker boundary — the guarantee heicTransform.ts's caller (imageViewer.tsx)
// depends on now that the decode runs on a separate thread instead of being awaited in place.

// heicCodec.ts caches its decoder promise in a module-level `let` (see heic-codec.test.ts's own
// freshModule()) — resetModules + a fresh dynamic import per call is what keeps one test's fakeLib from
// leaking into the next.
async function exposeOverChannel(deps: HeicTransformDeps): Promise<{ remote: Comlink.Remote<HeicWorkerApi>; close: () => void }> {
	vi.resetModules()
	const { runHeicTransform } = await import("@/features/preview/lib/heicCodec")

	const { port1, port2 } = new MessageChannel()
	port1.start()
	port2.start()

	const api: HeicWorkerApi = { transform: bytes => runHeicTransform(bytes, deps) }

	Comlink.expose(api, port1)

	return {
		remote: Comlink.wrap<HeicWorkerApi>(port2),
		close: () => {
			port1.close()
			port2.close()
		}
	}
}

// A minimal libheif-shaped fake — just enough surface for runHeicTransform's happy/throw paths.
// heic-codec.test.ts owns the exhaustive decode/encode matrix; this file only needs the two shapes
// below to prove the boundary-crossing behavior, not re-prove decode correctness.
function fakeLib(decodeThrows?: unknown): HeicDecoderModule {
	class HeifDecoder {
		decoder: unknown = true

		decode(): {
			get_width: () => number
			get_height: () => number
			display: (target: DecodedHeicImage, callback: (result: unknown) => void) => void
			free: () => void
		}[] {
			if (decodeThrows !== undefined) {
				// eslint-disable-next-line @typescript-eslint/only-throw-error -- deliberately a non-Error throw, mirroring decode()'s real WASM-trap failure shape
				throw decodeThrows
			}

			return [
				{
					get_width: () => 2,
					get_height: () => 2,
					display: (target, callback) => {
						target.data.fill(128)
						callback({})
					},
					free: () => undefined
				}
			]
		}
	}

	return { HeifDecoder, heif_context_free: () => undefined }
}

function depsFor(lib: HeicDecoderModule): HeicTransformDeps {
	return {
		getDecoder: () => Promise.resolve(lib),
		encodeJpeg: () => Promise.resolve(new Blob(["jpeg"], { type: "image/jpeg" })),
		encodeThumb: () => Promise.resolve(new Blob(["thumb"], { type: "image/webp" }))
	}
}

describe("heic worker boundary — a real Comlink round trip over MessageChannel", () => {
	it("resolves with a Blob on the wrapped side", async () => {
		const { remote, close } = await exposeOverChannel(depsFor(fakeLib()))

		try {
			await expect(remote.transform(new Uint8Array([1, 2, 3]))).resolves.toBeInstanceOf(Blob)
		} finally {
			close()
		}
	})

	it("transfers the input buffer instead of cloning it — the sender's buffer is detached after the call", async () => {
		const { remote, close } = await exposeOverChannel(depsFor(fakeLib()))
		const bytes = new Uint8Array([1, 2, 3])
		const buffer = bytes.buffer

		try {
			await remote.transform(Comlink.transfer(bytes, [buffer]))

			expect(buffer.byteLength).toBe(0)
		} finally {
			close()
		}
	})

	it("still rejects with a clean Error once a raw non-Error throw has crossed the boundary", async () => {
		const { remote, close } = await exposeOverChannel(depsFor(fakeLib("native boom")))

		try {
			const rejection: unknown = await remote.transform(new Uint8Array([1, 2, 3])).catch((e: unknown) => e)

			expect(rejection).toBeInstanceOf(Error)
			expect((rejection as Error).message).toBe("heic transform failed")
		} finally {
			close()
		}
	})
})
