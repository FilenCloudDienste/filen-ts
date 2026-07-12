import { beforeEach, describe, expect, it, vi } from "vitest"
import type { AnyFile } from "@filen/sdk-rs"

// The engine imports the store, which imports the kv adapter → leader (real election needs
// navigator.locks/BroadcastChannel/workers, absent under node). Replace leader with a Map-backed fake,
// exactly like adapter.test.ts, so the store + output-prefs persistence work end to end.
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

import { kvGetJson } from "@/lib/storage/adapter"
import { useAudioStore } from "@/features/audio/store/useAudioStore"
import {
	AudioEngine,
	audioOutputPrefsSchema,
	type AudioElementAdapter,
	type AudioElementEvents,
	type AudioEngineDeps,
	type TrackSource
} from "@/features/audio/lib/engine"
import type { ElementSample, QueueTrack } from "@/features/audio/store/audioQueue"

function track(uuid: string): QueueTrack {
	return { uuid, name: uuid, mime: "audio/mpeg", contentType: "audio/mpeg", file: {} as unknown as AnyFile }
}

// Drain the microtask queue so the fire-and-forget auto-skip / persist chains settle before asserting.
async function flush(): Promise<void> {
	for (let i = 0; i < 60; i++) {
		await Promise.resolve()
	}
}

interface FakeElement {
	adapter: AudioElementAdapter
	calls: {
		load: string[]
		play: number
		pause: number
		seek: number[]
		clear: number
		dispose: number
		volume: number[]
		muted: boolean[]
	}
	setSample: (sample: ElementSample) => void
	setPlayImpl: (impl: () => Promise<void>) => void
}

function makeFakeElement(): FakeElement {
	const calls = {
		load: [] as string[],
		play: 0,
		pause: 0,
		seek: [] as number[],
		clear: 0,
		dispose: 0,
		volume: [] as number[],
		muted: [] as boolean[]
	}
	let sample: ElementSample = { currentTimeMs: 0, durationMs: 0, paused: true, ended: false }
	let playImpl: () => Promise<void> = () => Promise.resolve()

	const adapter: AudioElementAdapter = {
		load: src => {
			calls.load.push(src)
		},
		play: () => {
			calls.play++

			return playImpl()
		},
		pause: () => {
			calls.pause++
		},
		seek: seconds => {
			calls.seek.push(seconds)
		},
		clear: () => {
			calls.clear++
		},
		setVolume: volume => {
			calls.volume.push(volume)
		},
		setMuted: muted => {
			calls.muted.push(muted)
		},
		sample: () => sample,
		dispose: () => {
			calls.dispose++
		}
	}

	return {
		adapter,
		calls,
		setSample: next => {
			sample = next
		},
		setPlayImpl: impl => {
			playImpl = impl
		}
	}
}

interface Harness {
	engine: AudioEngine
	fake: FakeElement
	revoke: ReturnType<typeof vi.fn>
	resolveSource: ReturnType<typeof vi.fn<(track: QueueTrack) => Promise<TrackSource>>>
	setNow: (value: number) => void
	events: () => AudioElementEvents
}

function makeHarness(): Harness {
	const fake = makeFakeElement()
	const revoke = vi.fn<(url: string) => void>()
	const resolveSource = vi.fn<(t: QueueTrack) => Promise<TrackSource>>(t => Promise.resolve({ kind: "blob", url: `blob:${t.uuid}` }))
	let nowValue = 1_000
	let captured: AudioElementEvents | null = null

	const deps: AudioEngineDeps = {
		createElement: events => {
			captured = events

			return fake.adapter
		},
		resolveSource,
		revokeObjectUrl: revoke,
		now: () => nowValue
	}

	return {
		engine: new AudioEngine(deps),
		fake,
		revoke,
		resolveSource,
		setNow: value => {
			nowValue = value
		},
		events: () => {
			if (!captured) {
				throw new Error("element not created yet")
			}

			return captured
		}
	}
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
		lastError: null
	})
}

beforeEach(() => {
	fakeStore.clear()
	resetStore()
})

describe("enqueueAndPlay", () => {
	it("loads the start track and settles to playing", async () => {
		const h = makeHarness()

		await h.engine.enqueueAndPlay([track("a"), track("b")], 0)
		await flush()

		expect(h.resolveSource).toHaveBeenCalledTimes(1)
		expect(h.fake.calls.load).toEqual(["blob:a"])
		expect(h.fake.calls.play).toBe(1)
		expect(useAudioStore.getState().status).toBe("playing")
		expect(useAudioStore.getState().currentIndex).toBe(0)
	})

	it("settles idle for an empty track list without touching the element", async () => {
		const h = makeHarness()

		await h.engine.enqueueAndPlay([], 0)

		expect(h.resolveSource).not.toHaveBeenCalled()
		expect(useAudioStore.getState().status).toBe("idle")
	})
})

describe("blob-url revoke discipline", () => {
	it("revokes the outgoing blob url on a track switch", async () => {
		const h = makeHarness()

		await h.engine.enqueueAndPlay([track("a"), track("b")], 0)
		await flush()
		await h.engine.skipNext()
		await flush()

		expect(h.revoke).toHaveBeenCalledWith("blob:a")
		expect(h.fake.calls.load).toEqual(["blob:a", "blob:b"])
		expect(useAudioStore.getState().currentIndex).toBe(1)
	})

	it("revokes the live blob url on dispose", async () => {
		const h = makeHarness()

		await h.engine.enqueueAndPlay([track("a")], 0)
		await flush()
		h.engine.dispose()

		expect(h.revoke).toHaveBeenCalledWith("blob:a")
		expect(h.fake.calls.dispose).toBe(1)
	})

	it("does not revoke a stream source (no page-side cleanup)", async () => {
		const h = makeHarness()

		h.resolveSource.mockResolvedValue({ kind: "stream", url: "/sw/download/x" })

		await h.engine.enqueueAndPlay([track("a"), track("b")], 0)
		await flush()
		await h.engine.skipNext()
		await flush()

		expect(h.revoke).not.toHaveBeenCalled()
	})
})

describe("bounded auto-skip", () => {
	it("settles (paused) at the queue end rather than spinning when every track fails, loop off", async () => {
		const h = makeHarness()

		h.resolveSource.mockRejectedValue(new Error("boom"))

		await h.engine.enqueueAndPlay([track("a"), track("b"), track("c")], 0)
		await flush()

		expect(useAudioStore.getState().status).toBe("paused")
		expect(useAudioStore.getState().lastError).not.toBeNull()
	})

	it("stops after one bounded pass under loop all when every track fails", async () => {
		const h = makeHarness()

		useAudioStore.setState({ loopMode: "all" })
		h.resolveSource.mockRejectedValue(new Error("boom"))

		await h.engine.enqueueAndPlay([track("a"), track("b"), track("c")], 0)
		await flush()

		expect(useAudioStore.getState().status).toBe("paused")
		expect(useAudioStore.getState().lastError).not.toBeNull()
		// Bounded to a single pass (queueLength + 1 attempts), never unbounded.
		expect(h.resolveSource.mock.calls.length).toBeLessThanOrEqual(4)
	})

	it("resets the skip guard and clears the error on a later success", async () => {
		const h = makeHarness()

		h.resolveSource.mockRejectedValueOnce(new Error("boom"))

		await h.engine.enqueueAndPlay([track("a"), track("b")], 0)
		await flush()

		// a failed → auto-skip to b, which succeeds.
		expect(useAudioStore.getState().status).toBe("playing")
		expect(useAudioStore.getState().currentIndex).toBe(1)
		expect(useAudioStore.getState().lastError).toBeNull()
	})
})

describe("handleTrackEnd", () => {
	it("advances to the next track on a natural end", async () => {
		const h = makeHarness()

		await h.engine.enqueueAndPlay([track("a"), track("b")], 0)
		await flush()
		h.events().onEnded()
		await flush()

		expect(useAudioStore.getState().currentIndex).toBe(1)
		expect(h.fake.calls.load).toEqual(["blob:a", "blob:b"])
	})

	it("settles at the end of the queue with looping off", async () => {
		const h = makeHarness()

		await h.engine.enqueueAndPlay([track("a")], 0)
		await flush()
		h.events().onEnded()
		await flush()

		expect(useAudioStore.getState().status).toBe("paused")
		expect(useAudioStore.getState().currentIndex).toBe(0)
	})

	it("replays the same track under loop one", async () => {
		const h = makeHarness()

		useAudioStore.setState({ loopMode: "one" })

		await h.engine.enqueueAndPlay([track("a"), track("b")], 0)
		await flush()
		h.events().onEnded()
		await flush()

		expect(useAudioStore.getState().currentIndex).toBe(0)
		expect(h.fake.calls.load).toEqual(["blob:a", "blob:a"])
	})
})

describe("transport", () => {
	it("pause + resume flips status via the element", async () => {
		const h = makeHarness()

		await h.engine.enqueueAndPlay([track("a")], 0)
		await flush()

		h.engine.pause()
		expect(useAudioStore.getState().status).toBe("paused")

		h.engine.resume()
		await flush()
		expect(useAudioStore.getState().status).toBe("playing")
	})

	it("seek writes the position in ms and moves the element", async () => {
		const h = makeHarness()

		await h.engine.enqueueAndPlay([track("a")], 0)
		await flush()

		h.engine.seek(12)

		expect(h.fake.calls.seek).toContain(12)
		expect(useAudioStore.getState().positionMs).toBe(12_000)
	})

	it("skipPrevious restarts the current track when past the threshold", async () => {
		const h = makeHarness()

		await h.engine.enqueueAndPlay([track("a"), track("b")], 1)
		await flush()
		h.fake.setSample({ currentTimeMs: 8_000, durationMs: 200_000, paused: false, ended: false })

		await h.engine.skipPrevious()
		await flush()

		// Past 3s → restart, not a step back.
		expect(useAudioStore.getState().currentIndex).toBe(1)
		expect(h.fake.calls.seek).toContain(0)
	})
})

describe("position throttle", () => {
	it("coalesces rapid timeupdate ticks to the throttle cadence", async () => {
		const h = makeHarness()

		await h.engine.enqueueAndPlay([track("a")], 0)
		await flush()

		h.setNow(2_000)
		h.fake.setSample({ currentTimeMs: 1_000, durationMs: 200_000, paused: false, ended: false })
		h.events().onTimeUpdate()
		expect(useAudioStore.getState().positionMs).toBe(1_000)

		// Within the throttle window — ignored.
		h.setNow(2_100)
		h.fake.setSample({ currentTimeMs: 2_000, durationMs: 200_000, paused: false, ended: false })
		h.events().onTimeUpdate()
		expect(useAudioStore.getState().positionMs).toBe(1_000)

		// Past the window — written.
		h.setNow(2_400)
		h.fake.setSample({ currentTimeMs: 3_000, durationMs: 200_000, paused: false, ended: false })
		h.events().onTimeUpdate()
		expect(useAudioStore.getState().positionMs).toBe(3_000)
	})
})

describe("output prefs", () => {
	it("clamps and persists volume, reading back a schema-valid blob", async () => {
		const h = makeHarness()

		h.engine.setVolume(1.7)
		await flush()

		await expect(kvGetJson("audio.v1.output", audioOutputPrefsSchema)).resolves.toEqual({ volume: 1, muted: false })
	})

	it("persists muted alongside volume", async () => {
		const h = makeHarness()

		h.engine.setVolume(0.4)
		h.engine.setMuted(true)
		await flush()

		await expect(kvGetJson("audio.v1.output", audioOutputPrefsSchema)).resolves.toEqual({ volume: 0.4, muted: true })
	})
})

describe("dispose", () => {
	it("clears the store and tears the element down", async () => {
		const h = makeHarness()

		await h.engine.enqueueAndPlay([track("a"), track("b")], 0)
		await flush()

		h.engine.dispose()

		const state = useAudioStore.getState()

		expect(state.queue).toEqual([])
		expect(state.status).toBe("idle")
		expect(h.fake.calls.dispose).toBe(1)
	})
})
