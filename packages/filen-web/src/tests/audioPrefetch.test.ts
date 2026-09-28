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
import { backfillTrackDuration, getTrackTags, putTrackTags, resetTrackTags } from "@/features/audio/store/useTrackTagsStore"
import type { TrackTagRecord } from "@/features/audio/lib/trackTags.logic"
import type { ElementSample, QueueTrack } from "@/features/audio/store/audioQueue"

function record(title: string, cover: boolean): TrackTagRecord {
	return { title, artist: null, album: null, durationSec: null, cover, parsed: true, at: 0 }
}

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
	setSample: (next: Partial<ElementSample>) => void
}

function makeFakeElement(initialEvents: AudioElementEvents): FakeElement {
	const calls = { load: [] as string[], play: 0, pause: 0, clear: 0, dispose: 0, rebindCount: 0 }
	let events = initialEvents
	let sample: ElementSample = { currentTimeMs: 0, durationMs: 0, paused: true, ended: false }

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
		},
		setSample: next => {
			sample = { ...sample, ...next }
		}
	}
}

interface Harness {
	engine: AudioEngine
	mainFakes: FakeElement[]
	prefetchFakes: FakeElement[]
	resolveSource: ReturnType<typeof vi.fn<(t: QueueTrack, signal: AbortSignal) => Promise<TrackSource>>>
	resolveCover: ReturnType<typeof vi.fn<(t: QueueTrack, s: TrackSource) => Promise<{ cover: Blob | null } | null>>>
}

function makeHarness(): Harness {
	const mainFakes: FakeElement[] = []
	const prefetchFakes: FakeElement[] = []
	const resolveSource = vi.fn<(t: QueueTrack, signal: AbortSignal) => Promise<TrackSource>>(t =>
		Promise.resolve({ kind: "blob", url: `blob:${t.uuid}`, blob: new Blob() })
	)
	// The real service records the track's tags as part of reading its cover; the fake does the same.
	const resolveCover = vi.fn<(t: QueueTrack, s: TrackSource) => Promise<{ cover: Blob | null } | null>>(t => {
		putTrackTags(t.uuid, record(t.uuid, false))

		return Promise.resolve({ cover: null })
	})

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
		resolveCover
	}

	return { engine: new AudioEngine(deps), mainFakes, prefetchFakes, resolveSource, resolveCover }
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
		coverUrlsByUuid: {}
	})
}

beforeEach(() => {
	fakeStore.clear()
	resetStore()
	resetTrackTags()
})

describe("prefetch — one-ahead warm-up", () => {
	it("resolves and warms the next track right after the current one starts playing", async () => {
		const h = makeHarness()

		await h.engine.enqueueAndPlay([track("a"), track("b")], 0)
		await flush()

		expect(h.resolveSource).toHaveBeenCalledTimes(2)
		expect(h.resolveSource).toHaveBeenNthCalledWith(2, track("b"), expect.any(AbortSignal))
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
		const resolveSource = vi.fn<(t: QueueTrack) => Promise<TrackSource>>(t =>
			Promise.resolve({ kind: "blob", url: `blob:${t.uuid}`, blob: new Blob() })
		)
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
		expect(h.resolveSource).toHaveBeenLastCalledWith(track("c"), expect.any(AbortSignal))

		// The element that warmed "b" is the one now playing, rebound exactly once, never reloaded.
		expect(h.prefetchFakes[0]?.calls.play).toBe(1)
		expect(h.prefetchFakes[0]?.calls.rebindCount).toBe(1)
		expect(h.prefetchFakes[0]?.calls.load).toEqual(["blob:b"])

		// The outgoing cold-started "a" element was retired.
		expect(h.mainFakes[0]?.calls.dispose).toBe(1)
		expect(useAudioStore.getState().currentIndex).toBe(1)
		expect(useAudioStore.getState().status).toBe("playing")
	})

	it("publishes the promoted element's duration — its own durationchange fired into the inert warm-up events", async () => {
		const h = makeHarness()

		await h.engine.enqueueAndPlay([track("a"), track("b")], 0)
		await flush()

		// The warm-up reached metadata while silently buffering: it fired durationchange into the inert
		// events, and a loaded element never re-fires it, so promotion is the last chance to read it.
		h.prefetchFakes[0]?.setSample({ durationMs: 60_000 })
		useAudioStore.getState().setDuration(120_000)

		await h.engine.skipNext()
		await flush()

		expect(h.prefetchFakes[0]?.calls.play).toBe(1)
		// Not the outgoing track's 120s, and not the 0 setCurrent wrote — a dead, disabled scrubber.
		expect(useAudioStore.getState().durationMs).toBe(60_000)
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

	it("a shuffle toggle re-warms only when the next track changed", async () => {
		const h = makeHarness()

		await h.engine.enqueueAndPlay([track("a"), track("b"), track("c")], 0)
		await flush()
		expect(h.prefetchFakes).toHaveLength(1)

		h.engine.setShuffleEnabled(true)
		await flush()

		const { queue, shuffleOrder } = useAudioStore.getState()
		const next = queue[shuffleOrder[1] ?? -1]?.uuid
		const live = h.prefetchFakes.filter(fake => fake.calls.dispose === 0)

		expect(live).toHaveLength(1)
		expect(live[0]?.calls.load).toEqual([`blob:${String(next)}`])
		// "b" still next keeps the warm element; "c" next re-warms once.
		expect(h.resolveSource).toHaveBeenCalledTimes(next === "b" ? 2 : 3)
	})

	it("a loop toggle mid-queue keeps the warmed next track instead of re-resolving it", async () => {
		const h = makeHarness()

		await h.engine.enqueueAndPlay([track("a"), track("b"), track("c")], 0)
		await flush()

		h.engine.setLoopMode("all")
		h.engine.setLoopMode("one")
		h.engine.setLoopMode("off")
		await flush()

		expect(h.resolveSource).toHaveBeenCalledTimes(2)
		expect(h.prefetchFakes).toHaveLength(1)
		expect(h.prefetchFakes[0]?.calls.dispose).toBe(0)
	})

	it("a loop toggle while the next track is still resolving lets that warm-up finish", async () => {
		const h = makeHarness()
		const signals: AbortSignal[] = []
		let finishB: (source: TrackSource) => void = () => undefined

		h.resolveSource.mockImplementation((t, signal) => {
			if (t.uuid !== "b") {
				return Promise.resolve({ kind: "blob", url: `blob:${t.uuid}`, blob: new Blob() })
			}

			signals.push(signal)

			return new Promise<TrackSource>(resolve => {
				finishB = resolve
			})
		})

		await h.engine.enqueueAndPlay([track("a"), track("b"), track("c")], 0)
		await flush()

		h.engine.setLoopMode("all")
		await flush()

		expect(signals).toHaveLength(1)
		expect(signals[0]?.aborted).toBe(false)

		finishB({ kind: "blob", url: "blob:b", blob: new Blob() })
		await flush()

		expect(h.prefetchFakes).toHaveLength(1)
		expect(h.prefetchFakes[0]?.calls.load).toEqual(["blob:b"])
	})

	it("shuffle-play sets shuffle inside the queue swap, never warming the outgoing queue's next track", async () => {
		const h = makeHarness()

		await h.engine.enqueueAndPlay([track("a"), track("b"), track("c")], 0)
		await flush()
		h.resolveSource.mockClear()

		await h.engine.enqueueAndPlay([track("x"), track("y"), track("z")], 0, { shuffle: true })
		await flush()

		const state = useAudioStore.getState()

		expect(state.shuffleEnabled).toBe(true)
		expect(state.shuffleOrder).toHaveLength(3)
		expect(h.resolveSource.mock.calls.map(call => call[0].uuid).every(uuid => ["x", "y", "z"].includes(uuid))).toBe(true)
	})

	it("tearing a warm-up down aborts its in-flight resolve", async () => {
		const h = makeHarness()
		const signals = new Map<string, AbortSignal>()

		h.resolveSource.mockImplementation((t, signal) => {
			signals.set(t.uuid, signal)

			return t.uuid === "b"
				? new Promise<TrackSource>(() => undefined)
				: Promise.resolve({ kind: "blob", url: `blob:${t.uuid}`, blob: new Blob() })
		})

		await h.engine.enqueueAndPlay([track("a"), track("b"), track("c")], 0)
		await flush()
		expect(signals.get("b")?.aborted).toBe(false)

		await h.engine.playIndex(2)
		await flush()

		expect(signals.get("b")?.aborted).toBe(true)
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

			return Promise.resolve({ kind: "blob", url: `blob:${t.uuid}`, blob: new Blob() })
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
		deferred.get("b")?.({ kind: "blob", url: "blob:b", blob: new Blob() })
		await flush()

		// The superseded continuation must bail at the staleness guard instead of resurrecting the slot
		// with the OLD queue's bytes at a raw index that now belongs to a different track.
		expect(h.prefetchFakes.flatMap(fake => fake.calls.load)).not.toContain("blob:b")

		// Releasing the new track lets playback and the new queue's own warm-up proceed normally.
		deferred.get("y")?.({ kind: "blob", url: "blob:y", blob: new Blob() })
		await second
		await flush()

		expect(h.mainFakes.some(fake => fake.calls.load.includes("blob:y") && fake.calls.play > 0)).toBe(true)
		expect(h.prefetchFakes.flatMap(fake => fake.calls.load)).toContain("blob:z")
	})
})

describe("prefetch — single-track loop all", () => {
	it("never warms the track already playing, and replays it in place at the end", async () => {
		const h = makeHarness()

		useAudioStore.setState({ loopMode: "all" })
		await h.engine.enqueueAndPlay([track("a")], 0)
		await flush()

		expect(h.prefetchFakes).toHaveLength(0)
		expect(h.resolveSource).toHaveBeenCalledTimes(1)

		h.mainFakes[0]?.setSample({ durationMs: 90_000 })
		await h.engine.handleTrackEnd()
		await flush()

		expect(h.resolveSource).toHaveBeenCalledTimes(1)
		expect(h.mainFakes).toHaveLength(1)
		expect(h.mainFakes[0]?.calls.play).toBe(2)
		expect(h.prefetchFakes).toHaveLength(0)
		expect(useAudioStore.getState().status).toBe("playing")
		expect(useAudioStore.getState().durationMs).toBe(90_000)
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
	it("reads covers for exactly the current and prefetched track, never the rest of the queue", async () => {
		const h = makeHarness()

		await h.engine.enqueueAndPlay([track("a"), track("b"), track("c"), track("d")], 0)
		await flush()

		const read = h.resolveCover.mock.calls.map(call => call[0].uuid).sort()

		expect(read).toEqual(["a", "b"])
	})

	it("skips the read for a track whose tags say it has no cover", async () => {
		const h = makeHarness()

		putTrackTags("a", record("A", false))

		await h.engine.enqueueAndPlay([track("a")], 0)
		await flush()

		expect(h.resolveCover).not.toHaveBeenCalled()
	})

	it("reads again a cover the LRU evicted", async () => {
		const h = makeHarness()

		h.resolveCover.mockImplementation(t => {
			putTrackTags(t.uuid, record(t.uuid, true))

			return Promise.resolve({ cover: new Blob([t.uuid], { type: "image/webp" }) })
		})

		const tracks = Array.from({ length: 11 }, (_, i) => track(`t${String(i)}`))

		await h.engine.enqueueAndPlay(tracks, 0)
		await flush()

		expect(useAudioStore.getState().coverUrlsByUuid["t0"]).toBeDefined()

		for (let i = 1; i < 10; i++) {
			await h.engine.skipNext()
			await flush()
		}

		// Ten tracks later t0's cover URL has left the 8-entry LRU.
		expect(useAudioStore.getState().coverUrlsByUuid["t0"]).toBeUndefined()
		h.resolveCover.mockClear()

		await h.engine.playIndex(0)
		await flush()

		expect(h.resolveCover.mock.calls.map(call => call[0].uuid)).toContain("t0")
		expect(useAudioStore.getState().coverUrlsByUuid["t0"]).toBeDefined()
	})

	it("asks again on the next load when a read could not complete", async () => {
		const h = makeHarness()

		h.resolveCover.mockResolvedValueOnce(null)

		await h.engine.enqueueAndPlay([track("a")], 0)
		await flush()

		expect(getTrackTags("a")).toBeUndefined()

		await h.engine.playIndex(0)
		await flush()

		expect(h.resolveCover.mock.calls.filter(call => call[0].uuid === "a")).toHaveLength(2)
		expect(getTrackTags("a")).toEqual(record("a", false))
	})

	it("fills a missing duration from the media element, never overriding a tagged one", async () => {
		const h = makeHarness()

		putTrackTags("a", record("A", false))
		putTrackTags("b", { ...record("B", false), durationSec: 100 })

		await h.engine.enqueueAndPlay([track("a"), track("b")], 0)
		await flush()

		h.mainFakes[0]?.setSample({ durationMs: 212_400 })
		h.mainFakes[0]?.fire("onDurationChange")

		expect(getTrackTags("a")?.durationSec).toBe(212)

		backfillTrackDuration("b", 55)

		expect(getTrackTags("b")?.durationSec).toBe(100)
	})

	it("is a no-op when no resolveCover dep is supplied", async () => {
		const engine = new AudioEngine({
			createElement: events => makeFakeElement(events).adapter,
			resolveSource: t => Promise.resolve({ kind: "blob", url: `blob:${t.uuid}`, blob: new Blob() })
		})

		await expect(engine.enqueueAndPlay([track("a"), track("b")], 0)).resolves.toBeUndefined()
	})
})
