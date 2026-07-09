import { afterEach, describe, expect, it, vi } from "vitest"
import type { HeicDecoderModule, HeicTransformDeps } from "@/lib/preview/heic-codec"

// heic-codec.ts keeps its shared-decoder memoization in a module-level `let`, so every test needs its
// own module instance -- vi.resetModules() + a dynamic re-import before each one (mirrors
// save-download.test.ts's own freshModule() pattern), instead of a reset export added just for tests.
// log is hoisted-mocked up front: a plain vi.spyOn on the statically-imported instance wouldn't reach
// the freshly re-imported module's own reference to it once resetModules() decouples them.
const { errorSpy } = vi.hoisted(() => ({ errorSpy: vi.fn() }))

vi.mock("@/lib/log", () => ({
	log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: errorSpy, dump: () => [] }
}))

async function freshModule() {
	vi.resetModules()
	return import("@/lib/preview/heic-codec")
}

afterEach(() => {
	errorSpy.mockClear()
})

const BYTES = new Uint8Array([1, 2, 3])

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
function fakeLib(options: { width?: number; height?: number; displayResult?: unknown; decodeThrows?: unknown; imageCount?: number } = {}): {
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
				// eslint-disable-next-line @typescript-eslint/only-throw-error -- deliberately a non-Error throw, proving runHeicTransform never throws one through
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

function depsFor(lib: HeicDecoderModule, encodeJpeg?: HeicTransformDeps["encodeJpeg"], encodeThumb?: HeicTransformDeps["encodeThumb"]) {
	const getDecoderSpy = vi.fn(() => Promise.resolve(lib))
	const deps: HeicTransformDeps = {
		getDecoder: getDecoderSpy,
		encodeJpeg: encodeJpeg ?? (() => Promise.resolve(new Blob(["jpeg"], { type: "image/jpeg" }))),
		encodeThumb: encodeThumb ?? (() => Promise.resolve(new Blob(["thumb"], { type: "image/webp" })))
	}

	return { deps, getDecoderSpy }
}

describe("runHeicTransform — happy path", () => {
	it("resolves with the exact Blob encodeJpeg produced", async () => {
		const { runHeicTransform } = await freshModule()
		const { lib } = fakeLib()
		const producedBlob = new Blob(["jpeg-bytes"], { type: "image/jpeg" })
		const { deps } = depsFor(lib, () => Promise.resolve(producedBlob))

		await expect(runHeicTransform(BYTES, deps)).resolves.toBe(producedBlob)
	})

	it("passes the decoded dimensions and old-web's JPEG quality (0.85) to encodeJpeg", async () => {
		const { runHeicTransform } = await freshModule()
		const { lib } = fakeLib({ width: 4, height: 3 })
		const encodeJpeg = vi.fn((): Promise<Blob> => Promise.resolve(new Blob(["jpeg"])))
		const { deps } = depsFor(lib, encodeJpeg)

		await runHeicTransform(BYTES, deps)

		expect(encodeJpeg).toHaveBeenCalledWith(expect.objectContaining({ width: 4, height: 3 }), 0.85)
	})

	it("frees every decoded image and the decoder context after a successful decode", async () => {
		const { runHeicTransform } = await freshModule()
		const { lib, freeCalls, contextFreeCalls } = fakeLib()
		const { deps } = depsFor(lib)

		await runHeicTransform(BYTES, deps)

		expect(freeCalls).toEqual([0])
		expect(contextFreeCalls).toHaveLength(1)
	})
})

describe("runHeicTransform — thumbnail opts", () => {
	it("with no opts, calls encodeJpeg and never encodeThumb (the frozen default path)", async () => {
		const { runHeicTransform } = await freshModule()
		const { lib } = fakeLib()
		const encodeJpeg = vi.fn((): Promise<Blob> => Promise.resolve(new Blob(["jpeg"])))
		const encodeThumb = vi.fn((): Promise<Blob> => Promise.resolve(new Blob(["thumb"])))
		const { deps } = depsFor(lib, encodeJpeg, encodeThumb)

		await runHeicTransform(BYTES, deps)

		expect(encodeJpeg).toHaveBeenCalledTimes(1)
		expect(encodeThumb).not.toHaveBeenCalled()
	})

	it("with opts.maxDimension set, calls encodeThumb with the decoded pixels and that maxDimension, never encodeJpeg", async () => {
		const { runHeicTransform } = await freshModule()
		const { lib } = fakeLib({ width: 4, height: 3 })
		const encodeJpeg = vi.fn((): Promise<Blob> => Promise.resolve(new Blob(["jpeg"])))
		const encodeThumb = vi.fn((): Promise<Blob> => Promise.resolve(new Blob(["thumb"])))
		const { deps } = depsFor(lib, encodeJpeg, encodeThumb)

		await runHeicTransform(BYTES, deps, { maxDimension: 512 })

		expect(encodeThumb).toHaveBeenCalledWith(expect.objectContaining({ width: 4, height: 3 }), 512)
		expect(encodeJpeg).not.toHaveBeenCalled()
	})

	it("resolves with the exact Blob encodeThumb produced", async () => {
		const { runHeicTransform } = await freshModule()
		const { lib } = fakeLib()
		const producedBlob = new Blob(["thumb-bytes"], { type: "image/webp" })
		const { deps } = depsFor(lib, undefined, () => Promise.resolve(producedBlob))

		await expect(runHeicTransform(BYTES, deps, { maxDimension: 512 })).resolves.toBe(producedBlob)
	})
})

describe("runHeicTransform — decoder memoization", () => {
	it("loads the decoder once across sequential calls", async () => {
		const { runHeicTransform } = await freshModule()
		const { lib } = fakeLib()
		const { deps, getDecoderSpy } = depsFor(lib)

		await runHeicTransform(BYTES, deps)
		await runHeicTransform(BYTES, deps)

		expect(getDecoderSpy).toHaveBeenCalledTimes(1)
	})

	it("loads the decoder once across concurrent calls", async () => {
		const { runHeicTransform } = await freshModule()
		const { lib } = fakeLib()
		const { deps, getDecoderSpy } = depsFor(lib)

		await Promise.all([runHeicTransform(BYTES, deps), runHeicTransform(BYTES, deps)])

		expect(getDecoderSpy).toHaveBeenCalledTimes(1)
	})

	it("does not cache a failed decoder load — a later call retries", async () => {
		const { runHeicTransform } = await freshModule()
		const { lib } = fakeLib()
		let attempt = 0
		const getDecoderSpy = vi.fn(() => {
			attempt += 1

			return attempt === 1 ? Promise.reject(new Error("wasm init failed")) : Promise.resolve(lib)
		})
		const deps: HeicTransformDeps = {
			getDecoder: getDecoderSpy,
			encodeJpeg: () => Promise.resolve(new Blob(["jpeg"])),
			encodeThumb: () => Promise.resolve(new Blob(["thumb"]))
		}

		await expect(runHeicTransform(BYTES, deps)).rejects.toThrow()
		await expect(runHeicTransform(BYTES, deps)).resolves.toBeInstanceOf(Blob)

		expect(getDecoderSpy).toHaveBeenCalledTimes(2)
	})
})

describe("runHeicTransform — error mapping (never a throw-through)", () => {
	it("wraps a raw string thrown from decode() into a clean Error", async () => {
		const { runHeicTransform } = await freshModule()
		const { lib } = fakeLib({ decodeThrows: "native boom" })
		const { deps } = depsFor(lib)

		const rejection: unknown = await runHeicTransform(BYTES, deps).catch((e: unknown) => e)

		expect(rejection).toBeInstanceOf(Error)
		expect((rejection as Error).message).not.toBe("native boom")
	})

	it("wraps an empty images array into a clean Error", async () => {
		const { runHeicTransform } = await freshModule()
		const { lib } = fakeLib({ imageCount: 0 })
		const { deps } = depsFor(lib)

		await expect(runHeicTransform(BYTES, deps)).rejects.toBeInstanceOf(Error)
	})

	it.each([null, undefined])("wraps display() invoking its callback with %s into a clean Error", async displayResult => {
		const { runHeicTransform } = await freshModule()
		const { lib } = fakeLib({ displayResult })
		const { deps } = depsFor(lib)

		await expect(runHeicTransform(BYTES, deps)).rejects.toBeInstanceOf(Error)
	})

	it.each([0, -1])("wraps an invalid width (%i) into a clean Error", async size => {
		const { runHeicTransform } = await freshModule()
		const { lib } = fakeLib({ width: size })
		const { deps } = depsFor(lib)

		await expect(runHeicTransform(BYTES, deps)).rejects.toBeInstanceOf(Error)
	})

	it("wraps a non-Error encodeJpeg rejection into a clean Error, not a throw-through", async () => {
		const { runHeicTransform } = await freshModule()
		const { lib } = fakeLib()
		// eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- deliberately a non-Error rejection, proving runHeicTransform never throws one through
		const { deps } = depsFor(lib, () => Promise.reject("encode boom"))

		const rejection: unknown = await runHeicTransform(BYTES, deps).catch((e: unknown) => e)

		expect(rejection).toBeInstanceOf(Error)
		expect((rejection as Error).message).not.toBe("encode boom")
	})

	it("still frees the decoded image and decoder context when display() fails", async () => {
		const { runHeicTransform } = await freshModule()
		const { lib, freeCalls, contextFreeCalls } = fakeLib({ displayResult: null })
		const { deps } = depsFor(lib)

		await runHeicTransform(BYTES, deps).catch(() => undefined)

		expect(freeCalls).toEqual([0])
		expect(contextFreeCalls).toHaveLength(1)
	})

	it("logs the underlying failure via log.error before rejecting", async () => {
		const { runHeicTransform } = await freshModule()
		const { lib } = fakeLib({ decodeThrows: new Error("native boom") })
		const { deps } = depsFor(lib)

		await runHeicTransform(BYTES, deps).catch(() => undefined)

		expect(errorSpy).toHaveBeenCalledWith("heic-decode", expect.anything())
	})
})
