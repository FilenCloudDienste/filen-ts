import { afterEach, describe, expect, it, vi } from "vitest"
import { type } from "arktype"

// The slideshow's interval, shuffle and include-subfolders: kept on this device in the kv store, read at boot.

const { stored, kvSetJson } = vi.hoisted(() => ({
	stored: new Map<string, unknown>(),
	kvSetJson: vi.fn((key: string, value: unknown) => {
		stored.set(key, value)

		return Promise.resolve()
	})
}))

vi.mock("@/lib/storage/adapter", () => ({
	// Like the real adapter: a stored value that fails the schema reads as absent.
	kvGetJson: (key: string, schema: (value: unknown) => unknown) => {
		const value = stored.get(key)

		return Promise.resolve(value === undefined || schema(value) instanceof type.errors ? null : value)
	},
	kvSetJson,
	kvDelete: () => Promise.resolve()
}))

async function freshModule() {
	vi.resetModules()

	return import("@/features/preview/lib/slideshowPrefs")
}

afterEach(() => {
	stored.clear()
	kvSetJson.mockClear()
})

describe("slideshow preferences", () => {
	it("default to 5 seconds, in order, this directory only", async () => {
		const { loadSlideshowPrefs, slideshowPrefs } = await freshModule()

		await loadSlideshowPrefs()

		expect(slideshowPrefs()).toEqual({ intervalSeconds: 5, shuffle: false, subfolders: false })
	})

	it("read all three keys at boot", async () => {
		stored.set("preview.slideshow.interval.v1", 20)
		stored.set("preview.slideshow.shuffle.v1", true)
		stored.set("preview.slideshow.subfolders.v1", true)

		const { loadSlideshowPrefs, slideshowPrefs } = await freshModule()

		await loadSlideshowPrefs()

		expect(slideshowPrefs()).toEqual({ intervalSeconds: 20, shuffle: true, subfolders: true })
	})

	it("read a stored interval that is no preset as the default", async () => {
		stored.set("preview.slideshow.interval.v1", 7)

		const { loadSlideshowPrefs, slideshowPrefs } = await freshModule()

		await loadSlideshowPrefs()

		expect(slideshowPrefs().intervalSeconds).toBe(5)
	})

	it("store nothing for an interval that is no preset", async () => {
		const { setSlideshowPrefs, slideshowPrefs } = await freshModule()

		setSlideshowPrefs({ intervalSeconds: 7 as 5 })

		expect(slideshowPrefs().intervalSeconds).toBe(5)
		expect(kvSetJson).not.toHaveBeenCalled()
	})

	it("store only the key that changed", async () => {
		const { setSlideshowPrefs, slideshowPrefs } = await freshModule()

		setSlideshowPrefs({ shuffle: true })

		expect(slideshowPrefs()).toEqual({ intervalSeconds: 5, shuffle: true, subfolders: false })
		expect(kvSetJson).toHaveBeenCalledTimes(1)
		expect(kvSetJson).toHaveBeenCalledWith("preview.slideshow.shuffle.v1", true)
	})

	it("hand out the same object until a value changes", async () => {
		const { setSlideshowPrefs, slideshowPrefs } = await freshModule()
		const before = slideshowPrefs()

		expect(slideshowPrefs()).toBe(before)

		setSlideshowPrefs({ subfolders: true })

		expect(slideshowPrefs()).not.toBe(before)
	})
})
