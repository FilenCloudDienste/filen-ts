import { beforeEach, describe, expect, it, vi } from "vitest"
import { type } from "arktype"
import { kvGetJson } from "@/lib/storage/adapter"
import { audioPrefsSchema, useAudioStore } from "@/features/audio/store/useAudioStore"

// The store persists shuffle/loop through the real kv adapter facade, so replace the leader (real
// election needs navigator.locks/BroadcastChannel/workers, absent under node) with a Map-backed fake —
// same seam as adapter.test.ts. This exercises the adapter + persistence round-trip end to end.
const { fakeStore } = vi.hoisted(() => ({ fakeStore: new Map<string, string>() }))

vi.mock("@/lib/storage/leader", () => ({
	acquireStorage: () =>
		Promise.resolve({
			role: "leader" as const,
			api: {
				open: () => Promise.resolve(undefined),
				kvGet: (key: string) => Promise.resolve(fakeStore.get(key) ?? null),
				kvSet: (key: string, value: string) => {
					fakeStore.set(key, value)

					return Promise.resolve()
				},
				kvDelete: (key: string) => {
					fakeStore.delete(key)

					return Promise.resolve()
				},
				kvKeys: (prefix: string) => Promise.resolve([...fakeStore.keys()].filter(k => k.startsWith(prefix)))
			}
		})
}))

function resetStore(): void {
	useAudioStore.setState({
		queue: [],
		currentIndex: 0,
		status: "idle",
		positionMs: 0,
		durationMs: 0,
		shuffleEnabled: false,
		loopMode: "off",
		shuffleOrder: [],
		lastError: null,
		coverUrlsByUuid: {}
	})
}

beforeEach(() => {
	fakeStore.clear()
	resetStore()
})

describe("useAudioStore setters", () => {
	it("loadQueue replaces the queue and resets position/duration/error", () => {
		useAudioStore.setState({ positionMs: 5_000, durationMs: 9_000, lastError: { species: "plain", label: "x", message: "x" } })

		useAudioStore.getState().loadQueue([], 0, [])

		const state = useAudioStore.getState()

		expect(state.positionMs).toBe(0)
		expect(state.durationMs).toBe(0)
		expect(state.lastError).toBeNull()
	})

	it("setCurrent moves the index and resets the scrubber", () => {
		useAudioStore.setState({ positionMs: 4_000 })

		useAudioStore.getState().setCurrent(2, [2, 0, 1])

		expect(useAudioStore.getState().currentIndex).toBe(2)
		expect(useAudioStore.getState().shuffleOrder).toEqual([2, 0, 1])
		expect(useAudioStore.getState().positionMs).toBe(0)
	})

	it("reset clears playback but preserves persisted prefs", () => {
		useAudioStore.setState({ shuffleEnabled: true, loopMode: "all", status: "playing", positionMs: 1_000 })

		useAudioStore.getState().reset()

		const state = useAudioStore.getState()

		expect(state.status).toBe("idle")
		expect(state.positionMs).toBe(0)
		expect(state.shuffleEnabled).toBe(true)
		expect(state.loopMode).toBe("all")
	})

	it("reset does NOT clear the cover mirror (a manual queue clear keeps the cover cache alive)", () => {
		useAudioStore.getState().setCoverUrls({ a: "blob:a" })

		useAudioStore.getState().reset()

		expect(useAudioStore.getState().coverUrlsByUuid).toEqual({ a: "blob:a" })
	})

	it("setCoverUrls replaces the whole mirror (the engine passes the cache's full live snapshot)", () => {
		useAudioStore.getState().setCoverUrls({ a: "blob:a" })
		useAudioStore.getState().setCoverUrls({ b: "blob:b" })

		expect(useAudioStore.getState().coverUrlsByUuid).toEqual({ b: "blob:b" })
	})

	it("resetMetadata (logout only) clears the cover mirror", () => {
		useAudioStore.getState().setCoverUrls({ a: "blob:a" })

		useAudioStore.getState().resetMetadata()

		expect(useAudioStore.getState().coverUrlsByUuid).toEqual({})
	})
})

describe("audioPrefsSchema", () => {
	it("accepts a well-formed prefs object", () => {
		expect(audioPrefsSchema({ shuffleEnabled: true, loopMode: "one" })).toEqual({ shuffleEnabled: true, loopMode: "one" })
	})

	it("rejects an unknown loop mode", () => {
		expect(audioPrefsSchema({ shuffleEnabled: false, loopMode: "sometimes" })).toBeInstanceOf(type.errors)
	})

	it("rejects a non-boolean shuffle flag", () => {
		expect(audioPrefsSchema({ shuffleEnabled: "yes", loopMode: "off" })).toBeInstanceOf(type.errors)
	})
})

describe("prefs persistence round-trip", () => {
	it("setShuffle writes a schema-valid blob that reads back identically", async () => {
		useAudioStore.getState().setShuffle(true, [0, 1, 2])

		// Fire-and-forget persist — let the microtask settle.
		await Promise.resolve()
		await Promise.resolve()

		await expect(kvGetJson("audio.v1.prefs", audioPrefsSchema)).resolves.toEqual({ shuffleEnabled: true, loopMode: "off" })
	})

	it("setLoop persists the loop mode alongside the current shuffle flag", async () => {
		useAudioStore.getState().setShuffle(true, [])
		useAudioStore.getState().setLoop("all")

		await Promise.resolve()
		await Promise.resolve()

		await expect(kvGetJson("audio.v1.prefs", audioPrefsSchema)).resolves.toEqual({ shuffleEnabled: true, loopMode: "all" })
	})
})

describe("restoring the player's settings", () => {
	// hydrateAudioPrefs and warmMediaVolume load once per tab, so each test gets fresh modules.
	async function freshModules() {
		vi.resetModules()

		const adapter = await import("@/lib/storage/adapter")
		const store = await import("@/features/audio/store/useAudioStore")
		const volume = await import("@/lib/media/mediaVolume")

		return { adapter, store, volume }
	}

	it("restores shuffle, loop and the shared volume without starting playback", async () => {
		const { adapter, store, volume } = await freshModules()

		await adapter.kvSetJson("audio.v1.prefs", { shuffleEnabled: true, loopMode: "one" })
		await adapter.kvSetJson("media.volume.v1", { volume: 0.35, muted: true })
		await Promise.all([store.hydrateAudioPrefs(), volume.warmMediaVolume()])

		expect(store.useAudioStore.getState()).toMatchObject({ shuffleEnabled: true, loopMode: "one", status: "idle", queue: [] })
		expect(volume.useMediaVolumeStore.getState()).toEqual({ volume: 0.35, muted: true })
	})

	it("keeps a toggle made before the stored prefs arrived", async () => {
		const { adapter, store } = await freshModules()

		await adapter.kvSetJson("audio.v1.prefs", { shuffleEnabled: true, loopMode: "all" })

		const hydrating = store.hydrateAudioPrefs()

		store.useAudioStore.getState().setLoop("one")
		await hydrating

		expect(store.useAudioStore.getState()).toMatchObject({ shuffleEnabled: false, loopMode: "one" })
	})

	it("falls back to the defaults for a malformed blob", async () => {
		const { adapter, store } = await freshModules()

		await adapter.kvSetJson("audio.v1.prefs", { shuffleEnabled: "yes", loopMode: "sometimes" })
		await store.hydrateAudioPrefs()

		expect(store.useAudioStore.getState()).toMatchObject({ shuffleEnabled: false, loopMode: "off" })
	})
})
