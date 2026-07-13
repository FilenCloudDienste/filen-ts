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
