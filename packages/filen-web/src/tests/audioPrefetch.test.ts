import { beforeEach, describe, expect, it, vi } from "vitest"
import type { AnyFile } from "@filen/sdk-rs"

// Same leader-mock rationale as audioEngine.test.ts: the engine's output-prefs persistence goes through
// the real kv adapter, which needs a fake storage leader under node.
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

import { useAudioStore } from "@/features/audio/store/useAudioStore"
import {
	AudioEngine,
	type AudioElementAdapter,
	type AudioElementEvents,
	type AudioEngineDeps,
	type TrackSource
} from "@/features/audio/lib/engine"
import { EMPTY_TRACK_TAGS, type TrackTags } from "@/features/audio/lib/metadata"
import type { ElementSample, QueueTrack } from "@/features/audio/store/audioQueue"

function track(uuid: string): QueueTrack {
	return { uuid, name: uuid, mime: "audio/mpeg", contentType: "audio/mpeg", file: {} as unknown as AnyFile }
}

async function flush(): Promise<void> {
	for (let i = 0; i < 60; i++) {
		await Promise.resolve()
	}
}

interface FakeElement {
	adapter: AudioElementAdapter
	calls: { load: string[]; play: number; pause: number; clear: number; dispose: number; rebindCount: number }
	fire: (name: keyof AudioElementEvents) => void
}

function makeFakeElement(initialEvents: AudioElementEvents): FakeElement {
	const calls = { load: [] as string[], play: 0, pause: 0, clear: 0, dispose: 0, rebindCount: 0 }
	let events = initialEvents
	const sample: ElementSample = { currentTimeMs: 0, durationMs: 0, paused: true, ended: false }

	const adapter: AudioElementAdapter = {
		load: src => {
			calls.load.push(src)
		},
		play: () => {
			calls.play++

			return Promise.resolve()
		},
		pause: () => {
			calls.pause++
		},
		seek: () => undefined,
		clear: () => {
			calls.clear++
		},
		setVolume: () => undefined,
		setMuted: () => undefined,
		sample: () => sample,
		rebind: nextEvents => {
			events = nextEvents
			calls.rebindCount++
		},
		dispose: () => {
			calls.dispose++
		}
	}

	return {
		adapter,
		calls,
		fire: name => {
			events[name]()
		}
	}
}

interface Harness {
	engine: AudioEngine
	mainFakes: FakeElement[]
	prefetchFakes: FakeElement[]
	resolveSource: ReturnType<typeof vi.fn<(t: QueueTrack) => Promise<TrackSource>>>
	extractMetadata: ReturnType<typeof vi.fn<(t: QueueTrack, s: TrackSource) => Promise<TrackTags>>>
}

function makeHarness(): Harness {
	const mainFakes: FakeElement[] = []
	const prefetchFakes: FakeElement[] = []
	const resolveSource = vi.fn<(t: QueueTrack) => Promise<TrackSource>>(t => Promise.resolve({ kind: "blob", url: `blob:${t.uuid}` }))
	const extractMetadata = vi.fn<(t: QueueTrack, s: TrackSource) => Promise<TrackTags>>(() => Promise.resolve(EMPTY_TRACK_TAGS))

	const deps: AudioEngineDeps = {
		createElement: events => {
			const fake = makeFakeElement(events)

			mainFakes.push(fake)

			return fake.adapter
		},
		createPrefetchElement: events => {
			const fake = makeFakeElement(events)

			prefetchFakes.push(fake)

			return fake.adapter
		},
		resolveSource,
		extractMetadata
	}

	return { engine: new AudioEngine(deps), mainFakes, prefetchFakes, resolveSource, extractMetadata }
}

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
		tagsByUuid: {},
		coverUrlsByUuid: {}
	})
}

beforeEach(() => {
	fakeStore.clear()
	resetStore()
})

describe("prefetch — one-ahead warm-up", () => {
	it("resolves and warms the next track right after the current one starts playing", async () => {
		const h = makeHarness()

		await h.engine.enqueueAndPlay([track("a"), track("b")], 0)
		await flush()

		expect(h.resolveSource).toHaveBeenCalledTimes(2)
		expect(h.resolveSource).toHaveBeenNthCalledWith(2, track("b"))
		expect(h.prefetchFakes).toHaveLength(1)
		expect(h.prefetchFakes[0]?.calls.load).toEqual(["blob:b"])
		// Never played while merely warming.
		expect(h.prefetchFakes[0]?.calls.play).toBe(0)
	})

	it("never warms when nothing is next (single-track queue, loop off)", async () => {
		const h = makeHarness()

		await h.engine.enqueueAndPlay([track("a")], 0)
		await flush()

		expect(h.prefetchFakes).toHaveLength(0)
		expect(h.resolveSource).toHaveBeenCalledTimes(1)
	})

	it("is a no-op when no prefetch dep is supplied — zero extra resolves, zero extra elements", async () => {
		const resolveSource = vi.fn<(t: QueueTrack) => Promise<TrackSource>>(t => Promise.resolve({ kind: "blob", url: `blob:${t.uuid}` }))
		const engine = new AudioEngine({ createElement: events => makeFakeElement(events).adapter, resolveSource })

		await engine.enqueueAndPlay([track("a"), track("b")], 0)
		await flush()

		expect(resolveSource).toHaveBeenCalledTimes(1)
	})
})

describe("prefetch — promote on advance", () => {
	it("promotes the warmed element instead of resolving/loading a fresh one", async () => {
		const h = makeHarness()

		await h.engine.enqueueAndPlay([track("a"), track("b"), track("c")], 0)
		await flush()

		const callsBeforeSkip = h.resolveSource.mock.calls.length

		await h.engine.skipNext()
		await flush()

		// Only ONE new resolveSource — the fresh one-ahead prefetch for "c" — not a re-resolve of "b".
		expect(h.resolveSource.mock.calls.length).toBe(callsBeforeSkip + 1)
		expect(h.resolveSource).toHaveBeenLastCalledWith(track("c"))

		// The element that warmed "b" is the one now playing, rebound exactly once, never reloaded.
		expect(h.prefetchFakes[0]?.calls.play).toBe(1)
		expect(h.prefetchFakes[0]?.calls.rebindCount).toBe(1)
		expect(h.prefetchFakes[0]?.calls.load).toEqual(["blob:b"])

		// The outgoing cold-started "a" element was retired.
		expect(h.mainFakes[0]?.calls.dispose).toBe(1)
		expect(useAudioStore.getState().currentIndex).toBe(1)
		expect(useAudioStore.getState().status).toBe("playing")
	})

	it("keeps at most one element warmed ahead at a time", async () => {
		const h = makeHarness()

		await h.engine.enqueueAndPlay([track("a"), track("b"), track("c")], 0)
		await flush()
		expect(h.prefetchFakes).toHaveLength(1)

		await h.engine.skipNext()
		await flush()

		expect(h.prefetchFakes).toHaveLength(2)
		expect(h.prefetchFakes[1]?.calls.load).toEqual(["blob:c"])
	})
})

describe("prefetch — teardown on jump / rebuild", () => {
	it("tears down a stale warm-up when jumping to a track that isn't the warmed one", async () => {
		const h = makeHarness()

		await h.engine.enqueueAndPlay([track("a"), track("b"), track("c")], 0)
		await flush()

		await h.engine.playIndex(2)
		await flush()

		expect(h.prefetchFakes[0]?.calls.dispose).toBe(1)
	})

	it("tears down and reschedules on a shuffle toggle", async () => {
		const h = makeHarness()

		await h.engine.enqueueAndPlay([track("a"), track("b"), track("c")], 0)
		await flush()
		expect(h.prefetchFakes).toHaveLength(1)

		h.engine.setShuffleEnabled(true)
		await flush()

		expect(h.prefetchFakes[0]?.calls.dispose).toBe(1)
		expect(h.prefetchFakes.length).toBeGreaterThanOrEqual(2)
	})

	it("tears down on clearQueue and dispose", async () => {
		const h = makeHarness()

		await h.engine.enqueueAndPlay([track("a"), track("b")], 0)
		await flush()

		h.engine.clearQueue()

		expect(h.prefetchFakes[0]?.calls.dispose).toBe(1)
	})

	it("tears down a stale cross-queue prefetch instead of promoting it into an unrelated track", async () => {
		const h = makeHarness()

		// Arm a prefetch at raw index 1 ("b") off the first queue.
		await h.engine.enqueueAndPlay([track("a"), track("b"), track("c")], 0)
		await flush()
		expect(h.prefetchFakes).toHaveLength(1)
		expect(h.prefetchFakes[0]?.calls.load).toEqual(["blob:b"])

		// A completely different queue, started at the SAME raw index the stale prefetch happens to be
		// warmed at — loadAndPlay must not mistake this coincidence for "already warm".
		await h.engine.enqueueAndPlay([track("x"), track("y"), track("z")], 1)
		await flush()

		// The stale "b" element from the old queue is retired, never promoted into playback.
		expect(h.prefetchFakes[0]?.calls.dispose).toBe(1)
		expect(h.prefetchFakes[0]?.calls.play).toBe(0)

		// The new current track "y" is genuinely resolved, loaded, and played.
		const state = useAudioStore.getState()

		expect(state.queue[state.currentIndex]?.uuid).toBe("y")
		expect(h.mainFakes.some(fake => fake.calls.load.includes("blob:y") && fake.calls.play > 0)).toBe(true)
	})

	it("a queue replace invalidates a warm-up still awaiting its source, not just an already-warm one", async () => {
		const h = makeHarness()
		const deferred = new Map<string, (s: TrackSource) => void>()

		// "b" (the old queue's one-ahead target) and "y" (the new queue's current track) resolve only
		// when released; everything else resolves immediately.
		h.resolveSource.mockImplementation(t => {
			if (t.uuid === "b" || t.uuid === "y") {
				return new Promise<TrackSource>(resolve => {
					deferred.set(t.uuid, resolve)
				})
			}

			return Promise.resolve({ kind: "blob", url: `blob:${t.uuid}` })
		})

		// Old queue: "a" plays instantly; its warm-up for "b" is left IN FLIGHT (no element created yet —
		// the element only exists once the source resolves).
		await h.engine.enqueueAndPlay([track("a"), track("b"), track("c")], 0)
		await flush()
		expect(deferred.has("b")).toBe(true)
		expect(h.prefetchFakes).toHaveLength(0)

		// Replace the queue while that warm-up is still pending. The new current track "y" is also held
		// pending, so the new queue has NOT scheduled its own warm-up yet — the teardown inside
		// enqueueAndPlay is the ONLY thing standing between the stale continuation and the slot.
		const second = h.engine.enqueueAndPlay([track("x"), track("y"), track("z")], 1)

		await flush()
		deferred.get("b")?.({ kind: "blob", url: "blob:b" })
		await flush()

		// The superseded continuation must bail at the staleness guard instead of resurrecting the slot
		// with the OLD queue's bytes at a raw index that now belongs to a different track.
		expect(h.prefetchFakes.flatMap(fake => fake.calls.load)).not.toContain("blob:b")

		// Releasing the new track lets playback and the new queue's own warm-up proceed normally.
		deferred.get("y")?.({ kind: "blob", url: "blob:y" })
		await second
		await flush()

		expect(h.mainFakes.some(fake => fake.calls.load.includes("blob:y") && fake.calls.play > 0)).toBe(true)
		expect(h.prefetchFakes.flatMap(fake => fake.calls.load)).toContain("blob:z")
	})
})

describe("prefetch — warm-up failure", () => {
	it("clears the slot without touching current playback", async () => {
		const h = makeHarness()

		await h.engine.enqueueAndPlay([track("a"), track("b")], 0)
		await flush()

		h.prefetchFakes[0]?.fire("onError")
		await flush()

		expect(useAudioStore.getState().status).toBe("playing")
		expect(useAudioStore.getState().currentIndex).toBe(0)
		expect(useAudioStore.getState().lastError).toBeNull()
	})
})

describe("metadata extraction — current + one-ahead only", () => {
	it("extracts for exactly the current and prefetched track, never the rest of the queue", async () => {
		const h = makeHarness()

		await h.engine.enqueueAndPlay([track("a"), track("b"), track("c"), track("d")], 0)
		await flush()

		const extracted = h.extractMetadata.mock.calls.map(call => call[0].uuid).sort()

		expect(extracted).toEqual(["a", "b"])
	})

	it("is a no-op when no extractMetadata dep is supplied", async () => {
		const engine = new AudioEngine({
			createElement: events => makeFakeElement(events).adapter,
			resolveSource: t => Promise.resolve({ kind: "blob", url: `blob:${t.uuid}` })
		})

		await expect(engine.enqueueAndPlay([track("a"), track("b")], 0)).resolves.toBeUndefined()
	})
})
