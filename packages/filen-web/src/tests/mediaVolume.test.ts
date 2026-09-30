import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const { kvStore, kvSetJson } = vi.hoisted(() => {
	const store = new Map<string, unknown>()

	return {
		kvStore: store,
		kvSetJson: vi.fn((key: string, value: unknown) => {
			store.set(key, value)

			return Promise.resolve()
		})
	}
})

vi.mock("@/lib/storage/adapter", async () => {
	const { type } = await import("arktype")

	return {
		// Like the real adapter: absent and schema-invalid both read as null.
		kvGetJson: (key: string, schema: (value: unknown) => unknown) => {
			const parsed = kvStore.has(key) ? schema(kvStore.get(key)) : null

			return Promise.resolve(parsed instanceof type.errors ? null : parsed)
		},
		kvSetJson
	}
})

type MediaVolumeModule = typeof import("@/lib/media/mediaVolume")

// Module state (the warm load, the pending write) is per tab, so each test gets a fresh copy.
async function load(): Promise<MediaVolumeModule> {
	vi.resetModules()

	return await import("@/lib/media/mediaVolume")
}

beforeEach(() => {
	kvStore.clear()
	vi.useFakeTimers()
})

afterEach(() => {
	vi.useRealTimers()
})

const WRITE_SETTLED_MS = 1_000

describe("setMediaVolume", () => {
	it("clamps the level into 0-1", async () => {
		const { setMediaVolume, useMediaVolumeStore } = await load()

		setMediaVolume(1.7)

		expect(useMediaVolumeStore.getState().volume).toBe(1)

		setMediaVolume(-0.2)

		expect(useMediaVolumeStore.getState().volume).toBe(0)

		setMediaVolume(Number.NaN)

		expect(useMediaVolumeStore.getState().volume).toBe(1)
	})

	it("raising the level while muted unmutes; a level of 0 keeps the mute", async () => {
		const { setMediaVolume, toggleMediaMuted, useMediaVolumeStore } = await load()

		setMediaVolume(0.5)
		toggleMediaMuted()
		setMediaVolume(0)

		expect(useMediaVolumeStore.getState()).toEqual({ volume: 0, muted: true })

		setMediaVolume(0.6)

		expect(useMediaVolumeStore.getState()).toEqual({ volume: 0.6, muted: false })
	})
})

describe("warmMediaVolume", () => {
	it("restores the stored level, clamped on the way out", async () => {
		kvStore.set("media.volume.v1", { volume: 3, muted: true })

		const { warmMediaVolume, useMediaVolumeStore } = await load()

		await warmMediaVolume()

		expect(useMediaVolumeStore.getState()).toEqual({ volume: 1, muted: true })
	})

	it("reads the versioned key only: a shape it does not know falls back to the default", async () => {
		kvStore.set("media.volume.v1", { level: 0.3 })
		kvStore.set("media.volume", { volume: 0.3, muted: false })

		const { warmMediaVolume, useMediaVolumeStore } = await load()

		await warmMediaVolume()

		expect(useMediaVolumeStore.getState()).toEqual({ volume: 1, muted: false })
	})

	it("loads once", async () => {
		const { warmMediaVolume } = await load()

		expect(warmMediaVolume()).toBe(warmMediaVolume())
	})

	it("never overrides a change the user made before the stored level arrived", async () => {
		kvStore.set("media.volume.v1", { volume: 0.2, muted: false })

		const { warmMediaVolume, setMediaVolume, useMediaVolumeStore } = await load()
		const warming = warmMediaVolume()

		setMediaVolume(0.7)
		await warming

		expect(useMediaVolumeStore.getState().volume).toBe(0.7)
	})
})

describe("persisting", () => {
	it("writes once, after the changes settle, not per step", async () => {
		const { setMediaVolume } = await load()

		setMediaVolume(0.9)
		setMediaVolume(0.8)
		setMediaVolume(0.5)

		expect(kvSetJson).not.toHaveBeenCalled()

		await vi.advanceTimersByTimeAsync(WRITE_SETTLED_MS)

		expect(kvSetJson).toHaveBeenCalledTimes(1)
		expect(kvStore.get("media.volume.v1")).toEqual({ volume: 0.5, muted: false })
	})

	it("does not write a level equal to the one already stored", async () => {
		kvStore.set("media.volume.v1", { volume: 0.4, muted: false })

		const { warmMediaVolume, setMediaVolume } = await load()

		await warmMediaVolume()
		setMediaVolume(0.6)
		setMediaVolume(0.4)
		await vi.advanceTimersByTimeAsync(WRITE_SETTLED_MS)

		expect(kvSetJson).not.toHaveBeenCalled()
	})

	it("does not even schedule a write for a change to the current level", async () => {
		const { setMediaVolume } = await load()

		setMediaVolume(1)

		expect(vi.getTimerCount()).toBe(0)
	})

	it("persists a mute", async () => {
		const { toggleMediaMuted } = await load()

		toggleMediaMuted()
		await vi.advanceTimersByTimeAsync(WRITE_SETTLED_MS)

		expect(kvStore.get("media.volume.v1")).toEqual({ volume: 1, muted: true })
	})
})

describe("stepMediaVolume / toggleMediaMuted", () => {
	it("steps within bounds, unmuting on the way up at the level the mute left", async () => {
		const { setMediaVolume, toggleMediaMuted, stepMediaVolume, useMediaVolumeStore } = await load()

		setMediaVolume(0.5)
		toggleMediaMuted()
		stepMediaVolume(-0.05)

		expect(useMediaVolumeStore.getState()).toEqual({ volume: 0.5, muted: true })

		stepMediaVolume(0.05)

		expect(useMediaVolumeStore.getState().volume).toBeCloseTo(0.55)
		expect(useMediaVolumeStore.getState().muted).toBe(false)

		stepMediaVolume(1)

		expect(useMediaVolumeStore.getState().volume).toBe(1)
	})

	it("toggles the mute and keeps the level", async () => {
		const { setMediaVolume, toggleMediaMuted, useMediaVolumeStore } = await load()

		setMediaVolume(0.3)
		toggleMediaMuted()

		expect(useMediaVolumeStore.getState()).toEqual({ volume: 0.3, muted: true })

		toggleMediaMuted()

		expect(useMediaVolumeStore.getState()).toEqual({ volume: 0.3, muted: false })
	})

	it("adopts a level set on an element itself, clamped", async () => {
		const { adoptMediaVolume, useMediaVolumeStore } = await load()

		adoptMediaVolume(1.2, true)

		expect(useMediaVolumeStore.getState()).toEqual({ volume: 1, muted: true })
	})
})
