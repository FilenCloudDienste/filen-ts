import { afterEach, describe, expect, it, vi } from "vitest"
import { registerPreviewDisposer, runPreviewDisposers } from "@/lib/workers/previewDisposers"
import { serveBlobPort } from "@/features/preview/lib/origin/blobPort"
import { rangePortReader, RangePortClosedError } from "@/lib/media/rangePort"

afterEach(() => {
	runPreviewDisposers()
})

describe("previewDisposers", () => {
	it("runs every registered disposer once", () => {
		const dispose = vi.fn()

		registerPreviewDisposer("a", dispose)
		runPreviewDisposers()
		runPreviewDisposers()

		expect(dispose).toHaveBeenCalledTimes(1)
	})

	it("skips one unregistered before the run", () => {
		const dispose = vi.fn()
		const unregister = registerPreviewDisposer("a", dispose)

		unregister()
		runPreviewDisposers()

		expect(dispose).not.toHaveBeenCalled()
	})

	it("keeps running the rest when one throws", () => {
		const after = vi.fn()

		registerPreviewDisposer("broken", () => {
			throw new Error("boom")
		})
		registerPreviewDisposer("after", after)

		expect(() => {
			runPreviewDisposers()
		}).not.toThrow()
		expect(after).toHaveBeenCalledTimes(1)
	})
})

describe("serveBlobPort", () => {
	it("serves the Blob's ranges until sign-out closes the port", async () => {
		const reader = rangePortReader(serveBlobPort(new Blob([Uint8Array.of(1, 2, 3, 4, 5)])))
		const signal = new AbortController().signal

		await expect(reader.readRange(1, 4, signal)).resolves.toEqual(Uint8Array.of(2, 3, 4))

		const lost = new Promise<void>(resolve => {
			reader.onLost(resolve)
		})

		runPreviewDisposers()
		await lost
		await expect(reader.readRange(0, 1, signal)).rejects.toBeInstanceOf(RangePortClosedError)
	})

	it("unregisters a port that closed on its own", async () => {
		const lifetime = new AbortController()
		const reader = rangePortReader(serveBlobPort(new Blob([Uint8Array.of(1)]), lifetime))
		const lost = new Promise<void>(resolve => {
			reader.onLost(resolve)
		})

		lifetime.abort()
		await lost

		const later = vi.fn()

		registerPreviewDisposer("later", later)
		runPreviewDisposers()
		expect(later).toHaveBeenCalledTimes(1)
	})
})
