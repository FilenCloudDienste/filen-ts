import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { AnyFile } from "@filen/sdk-rs"

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
import { useMediaVolumeStore } from "@/lib/media/mediaVolume"
import {
	AudioEngine,
	type AudioElementAdapter,
	type AudioElementEvents,
	type AudioEngineDeps,
	type SmoothTransitionsDeps,
	type TrackSource
} from "@/features/audio/lib/engine"
import type { AudioOutput, ElementGain } from "@/features/audio/lib/audioOutput"
import type { ContextState } from "@/features/audio/lib/outputWatchdog.logic"
import { DEFAULT_SMOOTH_TRANSITIONS_PREFS, type SourceRoute, type TrackEdges } from "@/features/audio/lib/smoothTransitions.types"
import { useSmoothTransitionsStore } from "@/features/audio/store/useSmoothTransitionsStore"
import { putTrackTags, resetTrackTags } from "@/features/audio/store/useTrackTagsStore"
import type { TrackTagRecord } from "@/features/audio/lib/trackTags.logic"
import type { ElementSample, QueueTrack } from "@/features/audio/store/audioQueue"
import { loadedUrl } from "@/tests/audioTestSources"

// The smooth-transition half of the engine against fakes: elements whose play() can be held, routed gains that
// record their automation, and an output whose context state a test sets.

const DURATION_MS = 200_000

function track(uuid: string, name = `${uuid}.mp3`): QueueTrack {
	return { uuid, name, mime: "audio/mpeg", contentType: "audio/mpeg", file: {} as unknown as AnyFile }
}

function tags(overrides: Partial<TrackTagRecord> = {}): TrackTagRecord {
	return { title: null, artist: null, album: null, durationSec: 200, cover: false, parsed: true, at: 0, ...overrides }
}

async function flush(): Promise<void> {
	for (let i = 0; i < 80; i++) {
		await Promise.resolve()
	}
}

type GainEvent =
	| { kind: "trim"; value: number; ramp: number }
	| { kind: "hold"; value: number }
	| { kind: "curve"; curve: Float32Array; start: number; duration: number }

interface FakeGain {
	gain: ElementGain
	events: GainEvent[]
	released: boolean
}

function makeGain(): FakeGain {
	const fake: FakeGain = {
		events: [],
		released: false,
		gain: {
			setTrim: (value, ramp) => {
				fake.events.push({ kind: "trim", value, ramp })
			},
			holdFade: value => {
				fake.events.push({ kind: "hold", value })
			},
			scheduleFade: (curve, start, duration) => {
				fake.events.push({ kind: "curve", curve, start, duration })
			},
			whenAudible: () => Promise.resolve(true),
			release: () => {
				fake.released = true
			}
		}
	}

	return fake
}

function lastFade(gain: FakeGain | null): GainEvent | undefined {
	return gain?.events.filter(event => event.kind !== "trim").at(-1)
}

interface FakeElement {
	adapter: AudioElementAdapter
	label: string
	plays: number
	pauses: number
	disposed: boolean
	seeks: number[]
	loads: string[]
	volumes: number[]
	gain: FakeGain | null
	fire: (name: "onTimeUpdate" | "onEnded" | "onDurationChange") => void
	setSample: (next: Partial<ElementSample>) => void
	// The next play() waits until the returned controls settle it.
	holdPlay: () => { resolve: () => void; reject: (error: unknown) => void }
}

function makeElement(label: string, initialEvents: AudioElementEvents, routable: boolean): FakeElement {
	let events = initialEvents
	let sample: ElementSample = { currentTimeMs: 0, durationMs: 0, paused: true, ended: false }
	let held: PromiseWithResolvers<undefined> | null = null
	const fake: FakeElement = {
		label,
		plays: 0,
		pauses: 0,
		disposed: false,
		seeks: [],
		loads: [],
		volumes: [],
		gain: null,
		fire: name => {
			events[name]()
		},
		setSample: next => {
			sample = { ...sample, ...next }
		},
		holdPlay: () => {
			const pending = Promise.withResolvers<undefined>()

			held = pending

			return {
				resolve: () => {
					pending.resolve(undefined)
				},
				reject: pending.reject
			}
		},
		adapter: {
			load: source => {
				fake.loads.push(loadedUrl(source))
				sample = { ...sample, durationMs: DURATION_MS }
			},
			play: () => {
				fake.plays++

				const pending = held

				held = null

				if (pending !== null) {
					return pending.promise.then(() => {
						sample = { ...sample, paused: false }
					})
				}

				sample = { ...sample, paused: false }

				return Promise.resolve()
			},
			pause: () => {
				fake.pauses++
				sample = { ...sample, paused: true }
			},
			seek: seconds => {
				fake.seeks.push(seconds)
				sample = { ...sample, currentTimeMs: seconds * 1000 }
			},
			clear: () => undefined,
			setVolume: volume => {
				fake.volumes.push(volume)
			},
			setMuted: () => undefined,
			sample: () => sample,
			rebind: next => {
				events = next
			},
			dispose: () => {
				fake.disposed = true
			}
		}
	}

	if (routable) {
		fake.adapter.route = () => {
			fake.gain = makeGain()

			return fake.gain.gain
		}
	}

	return fake
}

interface FakeOutput extends AudioOutput {
	state: ContextState
	seconds: number
	isUsable: boolean
	unlocks: number
	resumes: number
	keepOpen: boolean[]
	closes: number
	masters: number[]
	stateListener: (() => void) | null
}

function makeOutput(): FakeOutput {
	const output: FakeOutput = {
		state: "running",
		seconds: 10,
		isUsable: true,
		unlocks: 0,
		resumes: 0,
		keepOpen: [],
		closes: 0,
		masters: [],
		stateListener: null,
		unlock: () => {
			output.unlocks++
		},
		get usable() {
			return output.isUsable
		},
		get contextSeconds() {
			return output.seconds
		},
		get contextState() {
			return output.state
		},
		selfSuspended: false,
		routedCount: 0,
		connect: () => null,
		setMaster: level => {
			output.masters.push(level)
		},
		idle: () => undefined,
		active: () => undefined,
		resume: () => {
			output.resumes++
		},
		setKeepOpen: keep => {
			output.keepOpen.push(keep)
		},
		closeIfUnused: () => {
			output.closes++
		},
		close: () => {
			output.closes++
		},
		onStateChange: listener => {
			output.stateListener = listener
		}
	}

	return output
}

interface Harness {
	engine: AudioEngine
	output: FakeOutput
	mains: FakeElement[]
	warms: FakeElement[]
	released: string[]
	resolves: string[]
	metadata: (string | null)[]
	edges: Map<string, TrackEdges>
	alive: () => FakeElement[]
	// The next main element's play() waits (or is refused) under the test's control.
	nextMainPlay: { hold: boolean; reject: boolean }
	heldPlays: { resolve: () => void; reject: (error: unknown) => void }[]
}

interface HarnessOptions {
	smooth?: boolean
	routable?: boolean
	webkit?: boolean
	availability?: "available" | "appleMobileGated"
	route?: SourceRoute
}

function makeHarness(options: HarnessOptions = {}): Harness {
	const mains: FakeElement[] = []
	const warms: FakeElement[] = []
	const released: string[] = []
	const resolves: string[] = []
	const metadata: (string | null)[] = []
	const edges = new Map<string, TrackEdges>()
	const output = makeOutput()
	const routable = options.routable ?? true
	const nextMainPlay = { hold: false, reject: false }
	const heldPlays: Harness["heldPlays"] = []
	const smooth: SmoothTransitionsDeps = {
		output,
		getEdges: t => Promise.resolve(edges.get(t.uuid) ?? null),
		availability: () => options.availability ?? "available",
		webkit: options.webkit ?? false,
		inGesture: () => true
	}
	const deps: AudioEngineDeps = {
		createElement: events => {
			const fake = makeElement(`main${String(mains.length)}`, events, routable)

			mains.push(fake)

			if (nextMainPlay.hold || nextMainPlay.reject) {
				const control = fake.holdPlay()

				if (nextMainPlay.reject) {
					control.reject(new DOMException("not allowed", "NotAllowedError"))
				}

				heldPlays.push(control)
				nextMainPlay.hold = false
				nextMainPlay.reject = false
			}

			return fake.adapter
		},
		createPrefetchElement: events => {
			const fake = makeElement(`warm${String(warms.length)}`, events, routable)

			warms.push(fake)

			return fake.adapter
		},
		resolveSource: t => {
			resolves.push(t.uuid)

			const source: TrackSource = {
				media: { kind: "url", url: `src:${t.uuid}` },
				route: options.route ?? "direct",
				classify: () => Promise.resolve("other"),
				release: () => {
					released.push(t.uuid)
				}
			}

			return Promise.resolve(source)
		},
		mediaSession: {
			setMetadata: t => {
				metadata.push(t?.uuid ?? null)
			},
			setPlaybackState: () => undefined,
			setPositionState: () => undefined
		},
		...(options.smooth === false ? {} : { smoothTransitions: smooth })
	}

	return {
		engine: new AudioEngine(deps),
		output,
		mains,
		warms,
		released,
		resolves,
		metadata,
		edges,
		alive: () => [...mains, ...warms].filter(fake => !fake.disposed),
		nextMainPlay,
		heldPlays
	}
}

function playing(fakes: FakeElement[]): FakeElement[] {
	return fakes.filter(fake => !fake.disposed && !fake.adapter.sample().paused)
}

function enable(patch: Partial<typeof DEFAULT_SMOOTH_TRANSITIONS_PREFS> = {}): void {
	useSmoothTransitionsStore.setState({ prefs: { ...DEFAULT_SMOOTH_TRANSITIONS_PREFS, enabled: true, matchLoudness: false, ...patch } })
}

// Plays a two-track queue to where the warm element waits and the plan is known.
async function start(h: Harness, tracks: QueueTrack[] = [track("a"), track("b")]): Promise<{ out: FakeElement; warm: FakeElement }> {
	await h.engine.enqueueAndPlay(tracks, 0)
	await flush()

	const out = h.mains.at(-1)
	const warm = h.warms.at(-1)

	if (out === undefined || warm === undefined) {
		throw new Error("nothing warmed")
	}

	out.setSample({ currentTimeMs: 100_000, durationMs: DURATION_MS })
	out.fire("onTimeUpdate")

	return { out, warm }
}

// Moves the outgoing into its fade window.
async function reachWindow(out: FakeElement, ms = 194_500): Promise<void> {
	out.setSample({ currentTimeMs: ms })
	out.fire("onTimeUpdate")
	await flush()
}

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
	fakeStore.clear()
	resetTrackTags()
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
	useMediaVolumeStore.setState({ volume: 1, muted: false })
	useSmoothTransitionsStore.setState({ prefs: DEFAULT_SMOOTH_TRANSITIONS_PREFS, unavailable: null })
})

afterEach(() => {
	vi.useRealTimers()
})

describe("smooth transitions off", () => {
	it("never touches the output and never routes", async () => {
		const h = makeHarness()
		const { out, warm } = await start(h)

		await reachWindow(out)

		expect(h.output.unlocks).toBe(0)
		expect(out.gain).toBeNull()
		expect(warm.gain).toBeNull()
		expect(warm.plays).toBe(0)

		out.fire("onEnded")
		await flush()

		expect(useAudioStore.getState().currentIndex).toBe(1)
		expect(warm.plays).toBe(1)
	})

	it("starts no output on a device that is gated", async () => {
		enable()

		const h = makeHarness({ availability: "appleMobileGated" })
		const { out } = await start(h)

		expect(h.output.unlocks).toBe(0)
		expect(out.gain).toBeNull()
	})
})

describe("natural crossfade", () => {
	it("swaps at the incoming's play() and fades both, with the outgoing gone at its end", async () => {
		enable()

		const h = makeHarness()
		const { out, warm } = await start(h)

		expect(out.gain).not.toBeNull()
		expect(warm.gain).not.toBeNull()

		await reachWindow(out)

		expect(useAudioStore.getState().currentIndex).toBe(1)
		expect(h.metadata.at(-1)).toBe("b")
		expect(warm.plays).toBe(1)
		expect(playing(h.mains.concat(h.warms))).toHaveLength(2)

		const outFade = lastFade(out.gain)
		const inFade = lastFade(warm.gain)

		expect(outFade?.kind === "curve" && outFade.duration).toBeCloseTo(5.5, 1)
		expect(inFade?.kind === "curve" && inFade.duration).toBe(6)
		expect(warm.gain?.events.some(event => event.kind === "hold" && event.value === 0)).toBe(true)

		// The next warm-up waits for the fade: never three elements.
		expect(h.warms).toHaveLength(1)

		out.fire("onEnded")
		await flush()

		expect(out.disposed).toBe(true)
		expect(out.gain?.released).toBe(true)
		expect(h.released).toContain("a")
		expect(h.alive()).toHaveLength(1)
	})

	it("drops the outgoing when the fade timer runs out first", async () => {
		enable()

		const h = makeHarness()
		const { out } = await start(h)

		await reachWindow(out)
		vi.advanceTimersByTime(6_000)
		await flush()

		expect(out.disposed).toBe(true)
	})

	it("starts one fade when timeupdate and the backup timer both fire", async () => {
		enable()

		const h = makeHarness()
		const { out, warm } = await start(h)

		out.setSample({ currentTimeMs: 193_900, paused: false })
		out.fire("onTimeUpdate")

		const control = warm.holdPlay()

		vi.advanceTimersByTime(200)
		out.setSample({ currentTimeMs: 194_200 })
		out.fire("onTimeUpdate")
		control.resolve()
		await flush()

		expect(warm.plays).toBe(1)
		expect(useAudioStore.getState().currentIndex).toBe(1)
	})

	it("keeps the outgoing playing at full level when the incoming fails to start", async () => {
		enable()

		const h = makeHarness()
		const { out, warm } = await start(h)
		const control = warm.holdPlay()

		await reachWindow(out)
		control.reject(new Error("decode"))
		await flush()

		expect(useAudioStore.getState().currentIndex).toBe(0)
		expect(useAudioStore.getState().lastError).toBeNull()
		expect(warm.disposed).toBe(true)
		expect(out.gain?.events.some(event => event.kind === "curve")).toBe(false)

		// The outgoing reports to the transport again: its end loads the next track cold.
		out.fire("onEnded")
		await flush()

		expect(useAudioStore.getState().currentIndex).toBe(1)
		expect(h.resolves.filter(uuid => uuid === "b")).toHaveLength(2)
	})

	it("treats a pause while the incoming starts as no failure, and keeps it warm", async () => {
		enable()

		const h = makeHarness()
		const { out, warm } = await start(h)
		const control = warm.holdPlay()

		await reachWindow(out)
		h.engine.pause()
		control.reject(new DOMException("aborted", "AbortError"))
		await flush()

		expect(useAudioStore.getState().status).toBe("paused")
		expect(useAudioStore.getState().lastError).toBeNull()
		expect(useAudioStore.getState().currentIndex).toBe(0)
		expect(warm.disposed).toBe(false)
		expect(lastFade(warm.gain)).toEqual({ kind: "hold", value: 1 })

		// Playing on inside the window starts the transition again.
		h.engine.resume()
		await flush()
		out.fire("onTimeUpdate")
		await flush()

		expect(useAudioStore.getState().currentIndex).toBe(1)
	})

	it("never promotes twice when the outgoing ends while the incoming's play() is pending", async () => {
		enable()

		const h = makeHarness()
		const { out, warm } = await start(h)
		const control = warm.holdPlay()

		await reachWindow(out)
		out.fire("onEnded")
		control.resolve()
		await flush()

		expect(useAudioStore.getState().currentIndex).toBe(1)
		expect(warm.plays).toBe(1)
		expect(out.disposed).toBe(true)
		expect(h.resolves).toEqual(["a", "b"])
	})

	it("plays a prepared incoming at full level when it is promoted without a fade", async () => {
		enable()

		const h = makeHarness()
		const { out, warm } = await start(h)

		// The outgoing ends before any update reached the window (a frozen tab).
		out.fire("onEnded")
		await flush()

		expect(useAudioStore.getState().currentIndex).toBe(1)
		expect(lastFade(warm.gain)).toEqual({ kind: "hold", value: 1 })
	})

	it("starts the incoming past its leading silence and ends the fade where the outgoing's audio ends", async () => {
		enable()

		const h = makeHarness()

		h.edges.set("a", { status: "ok", durationSec: 200, inStartMs: 0, outEndFromEndMs: 3_000, fadeOutFromEndMs: null, boundary: null })
		h.edges.set("b", {
			status: "ok",
			durationSec: 200,
			inStartMs: 1_500,
			outEndFromEndMs: null,
			fadeOutFromEndMs: null,
			boundary: null
		})

		const { out, warm } = await start(h)

		await flush()
		out.fire("onTimeUpdate")

		expect(warm.seeks).toEqual([1.5])

		await reachWindow(out, 190_500)

		expect(useAudioStore.getState().currentIndex).toBe(0)

		await reachWindow(out, 191_200)

		expect(useAudioStore.getState().currentIndex).toBe(1)

		const outFade = lastFade(out.gain)

		expect(outFade?.kind === "curve" && outFade.duration).toBeCloseTo(5.8, 1)
	})
})

describe("transitions that never crossfade", () => {
	it("repeats on loop one without a curve", async () => {
		enable()
		useAudioStore.setState({ loopMode: "one" })

		const h = makeHarness()
		const { out, warm } = await start(h)

		await reachWindow(out)

		expect(warm.plays).toBe(0)

		out.fire("onEnded")
		await flush()

		expect(useAudioStore.getState().currentIndex).toBe(0)
		expect(out.gain?.events.some(event => event.kind === "curve")).toBe(false)
	})

	it("has nothing to fade into at the queue end", async () => {
		enable()

		const h = makeHarness()

		await h.engine.enqueueAndPlay([track("a")], 0)
		await flush()

		const out = h.mains[0]

		out?.setSample({ currentTimeMs: 199_000, durationMs: DURATION_MS })
		out?.fire("onTimeUpdate")
		await flush()

		expect(h.warms).toHaveLength(0)
		expect(out?.gain?.events.some(event => event.kind === "curve")).toBe(false)
	})

	it("overlaps an album run by 80 ms only, asked for early by the start latency", async () => {
		enable()
		putTrackTags("a", tags({ album: "Album", artist: "Artist" }))
		putTrackTags("b", tags({ album: "Album", artist: "Artist" }))

		const h = makeHarness()
		const { out, warm } = await start(h)

		await reachWindow(out)

		expect(useAudioStore.getState().currentIndex).toBe(0)

		out.setSample({ currentTimeMs: 199_000 })
		out.fire("onTimeUpdate")
		// The element's clock moves on with the wall clock; no update arrives before the end. The timer fires 80 ms
		// plus 1.5 × the assumed 50 ms start latency ahead of the end.
		vi.advanceTimersByTime(844)

		expect(useAudioStore.getState().currentIndex).toBe(0)

		out.setSample({ currentTimeMs: 199_920 })
		vi.advanceTimersByTime(1)
		await flush()

		expect(useAudioStore.getState().currentIndex).toBe(1)

		const inFade = lastFade(warm.gain)
		const outFade = lastFade(out.gain)

		// Both cross over exactly what is left of the outgoing.
		expect(inFade?.kind === "curve" && inFade.duration).toBeCloseTo(0.08, 3)
		expect(outFade?.kind === "curve" && outFade.duration).toBeCloseTo(0.08, 3)
	})

	it("plays out gapless after a seek into the window, and keeps the fade after a seek before it", async () => {
		enable()

		const h = makeHarness()
		const { out } = await start(h)

		h.engine.seek(100)
		await reachWindow(out)

		expect(useAudioStore.getState().currentIndex).toBe(1)

		const h2 = makeHarness()
		const second = await start(h2)

		h2.engine.seek(195)
		second.out.fire("onTimeUpdate")
		await reachWindow(second.out, 196_000)

		expect(useAudioStore.getState().currentIndex).toBe(0)
	})
})

describe("every stop or replace drops the fading element", () => {
	async function midFade(): Promise<{ h: Harness; out: FakeElement }> {
		enable()

		const h = makeHarness()
		const { out } = await start(h, [track("a"), track("b"), track("c")])

		await reachWindow(out)

		expect(out.disposed).toBe(false)

		return { h, out }
	}

	it("clearQueue", async () => {
		const { h, out } = await midFade()

		h.engine.clearQueue()

		expect(out.disposed).toBe(true)
	})

	it("enqueueAndPlay", async () => {
		const { h, out } = await midFade()

		await h.engine.enqueueAndPlay([track("x")], 0)

		expect(out.disposed).toBe(true)
	})

	it("removeAt of the current track", async () => {
		const { h, out } = await midFade()

		await h.engine.removeAt(1)

		expect(out.disposed).toBe(true)
	})

	it("a skip (cut)", async () => {
		const { h, out } = await midFade()

		await h.engine.skipNext()

		expect(out.disposed).toBe(true)
	})

	it("pause, which leaves the current at full level", async () => {
		const { h, out } = await midFade()

		h.engine.pause()

		expect(out.disposed).toBe(true)
		expect(lastFade(h.warms[0]?.gain ?? null)).toEqual({ kind: "hold", value: 1 })
	})

	it("dispose", async () => {
		const { h, out } = await midFade()

		h.engine.dispose()

		expect(out.disposed).toBe(true)
		expect(h.output.closes).toBeGreaterThan(0)
	})
})

describe("skips the user asks for", () => {
	it("starts the target at 0:00 on a cut", async () => {
		enable()

		const h = makeHarness()

		h.edges.set("b", {
			status: "ok",
			durationSec: 200,
			inStartMs: 1_500,
			outEndFromEndMs: null,
			fadeOutFromEndMs: null,
			boundary: null
		})

		const { out, warm } = await start(h)

		await flush()
		out.fire("onTimeUpdate")
		await h.engine.skipNext()

		expect(warm.seeks).toEqual([1.5, 0])
		expect(useAudioStore.getState().currentIndex).toBe(1)
		expect(out.disposed).toBe(true)
	})

	it("fades a warm target over the short fade from 0:00", async () => {
		enable({ manualTransition: "fade" })

		const h = makeHarness()

		h.edges.set("b", {
			status: "ok",
			durationSec: 200,
			inStartMs: 1_500,
			outEndFromEndMs: null,
			fadeOutFromEndMs: null,
			boundary: null
		})

		const { out, warm } = await start(h)

		await flush()
		out.fire("onTimeUpdate")
		await h.engine.skipNext()
		await flush()

		expect(warm.seeks.at(-1)).toBe(0)
		expect(useAudioStore.getState().currentIndex).toBe(1)

		const inFade = lastFade(warm.gain)
		const outFade = lastFade(out.gain)

		expect(inFade?.kind === "curve" && inFade.duration).toBe(1.5)
		expect(outFade?.kind === "curve" && outFade.duration).toBeCloseTo(1.5, 1)
		expect(h.alive()).toHaveLength(2)
	})

	it("fades a cold target into a fresh element, tearing the warm one down first", async () => {
		enable({ manualTransition: "fade" })

		const h = makeHarness()
		const { out, warm } = await start(h, [track("a"), track("b"), track("c")])

		await h.engine.playIndex(2)
		await flush()

		expect(warm.disposed).toBe(true)
		expect(useAudioStore.getState().currentIndex).toBe(2)

		const target = h.mains.at(-1)

		expect(target).not.toBe(out)
		expect(target?.loads).toEqual(["src:c"])
		expect(h.alive()).toHaveLength(2)

		const inFade = lastFade(target?.gain ?? null)

		expect(inFade?.kind === "curve" && inFade.duration).toBe(1.5)

		vi.advanceTimersByTime(1_600)
		await flush()

		expect(out.disposed).toBe(true)
	})

	it("fades the outgoing out alone when a cold target is not playing within 3 s", async () => {
		enable({ manualTransition: "fade" })

		const h = makeHarness()
		const { out } = await start(h, [track("a"), track("b"), track("c")])

		h.nextMainPlay.hold = true
		void h.engine.playIndex(2)
		await flush()
		vi.advanceTimersByTime(3_000)

		const outFade = lastFade(out.gain)

		expect(outFade?.kind === "curve" && outFade.duration).toBe(1.5)

		vi.advanceTimersByTime(1_600)

		expect(out.disposed).toBe(true)
		expect(h.alive()).toHaveLength(1)
	})

	it("cuts when the setting says so", async () => {
		enable({ manualTransition: "cut" })

		const h = makeHarness()
		const { out, warm } = await start(h)

		await h.engine.skipNext()

		expect(out.disposed).toBe(true)
		expect(lastFade(warm.gain)).toEqual({ kind: "hold", value: 1 })
	})
})

describe("the committed next track", () => {
	it("ends a shuffle lap on the track that was warmed, not on a second reshuffle", async () => {
		enable()

		const h = makeHarness({ smooth: false })
		const tracks = [track("a"), track("b"), track("c"), track("d")]

		useAudioStore.setState({ shuffleEnabled: true, loopMode: "all" })
		await h.engine.enqueueAndPlay(tracks, 0)
		await flush()

		// Walk to the lap's last track.
		for (let i = 0; i < 3; i++) {
			h.mains.at(-1)?.fire("onEnded")
			await flush()
		}

		const warmed = h.warms.at(-1)?.loads.at(-1)
		const resolvesBefore = h.resolves.length

		h.mains.at(-1)?.fire("onEnded")
		await flush()

		const state = useAudioStore.getState()

		expect(`src:${state.queue[state.currentIndex]?.uuid ?? ""}`).toBe(warmed)
		// Promoted, not loaded cold: only the next warm-up resolved.
		expect(h.resolves.length - resolvesBefore).toBeLessThanOrEqual(1)
	})
})

describe("routing", () => {
	it("replaces a routed element at the next cold load once the feature is off, and lets the output close", async () => {
		enable()

		const h = makeHarness()
		const { out } = await start(h, [track("a"), track("b"), track("c")])

		useSmoothTransitionsStore.setState({ prefs: { ...useSmoothTransitionsStore.getState().prefs, enabled: false } })

		expect(h.output.keepOpen.at(-1)).toBe(false)

		await h.engine.playIndex(2)
		await flush()

		expect(out.disposed).toBe(true)
		expect(out.gain?.released).toBe(true)
		expect(h.mains.at(-1)?.gain).toBeNull()
	})

	it("lets a fade in progress finish when the feature is turned off", async () => {
		enable()

		const h = makeHarness()
		const { out } = await start(h)

		await reachWindow(out)
		useSmoothTransitionsStore.setState({ prefs: { ...useSmoothTransitionsStore.getState().prefs, enabled: false } })

		expect(out.disposed).toBe(false)

		vi.advanceTimersByTime(6_000)

		expect(out.disposed).toBe(true)
	})

	it("routes the live elements when turned on mid-track, inside the gesture", async () => {
		const h = makeHarness()
		const { out, warm } = await start(h)

		enable()

		expect(h.output.unlocks).toBe(1)
		expect(out.gain).not.toBeNull()
		expect(warm.gain).not.toBeNull()
	})

	it("keeps a MediaSession source unrouted on WebKit and says why", async () => {
		enable()

		const h = makeHarness({ webkit: true, route: "session" })
		const { out } = await start(h)

		expect(out.gain).toBeNull()
		expect(useSmoothTransitionsStore.getState().unavailable).toBe("sourceIneligible")
	})

	it("routes nothing on a context that cannot start outside a gesture", async () => {
		enable()

		const h = makeHarness()

		h.output.isUsable = false

		const { out } = await start(h)

		expect(out.gain).toBeNull()
	})

	it("pins routed elements at full volume and moves the master instead; unrouted ones follow the store", async () => {
		enable()

		const h = makeHarness()
		const { out } = await start(h)

		useMediaVolumeStore.setState({ volume: 0.3, muted: false })

		expect(h.output.masters.at(-1)).toBe(0.3)
		expect(out.volumes.at(-1)).toBe(1)

		const plain = makeHarness({ smooth: false })
		const second = await start(plain)

		useMediaVolumeStore.setState({ volume: 0.4, muted: false })

		expect(second.out.volumes.at(-1)).toBe(0.4)
		expect(second.warm.volumes.at(-1)).toBe(0.4)
	})

	it("trims to the ReplayGain level and plays untagged tracks 6 dB quieter", async () => {
		enable({ matchLoudness: true })
		putTrackTags("a", tags({ gain: { trackDb: -8, trackPeak: 0.9, albumDb: null, albumPeak: null } }))
		putTrackTags("b", tags({ gain: { trackDb: null, trackPeak: null, albumDb: null, albumPeak: null } }))

		const h = makeHarness()
		const { out, warm } = await start(h)
		const outTrim = out.gain?.events.filter(event => event.kind === "trim").at(-1)
		const inTrim = warm.gain?.events.filter(event => event.kind === "trim").at(-1)

		expect(outTrim?.kind === "trim" && outTrim.value).toBeCloseTo(10 ** (-8 / 20), 5)
		expect(inTrim?.kind === "trim" && inTrim.value).toBeCloseTo(10 ** (-6 / 20), 5)
	})
})

describe("degraded output", () => {
	it("resumes once, then reloads the track unrouted at its position", async () => {
		enable()

		const h = makeHarness()
		const { out } = await start(h)
		let wall = 0

		vi.spyOn(Date, "now").mockImplementation(() => wall)
		h.output.state = "suspended"
		out.setSample({ currentTimeMs: 120_000, paused: false })
		out.fire("onTimeUpdate")

		expect(h.output.resumes).toBe(1)

		wall = 1_500
		out.fire("onTimeUpdate")
		await flush()

		expect(useSmoothTransitionsStore.getState().unavailable).toBe("degraded")

		const reloaded = h.mains.at(-1)

		expect(reloaded).not.toBe(out)
		expect(reloaded?.gain).toBeNull()
		expect(reloaded?.seeks).toEqual([120])
		expect(out.disposed).toBe(true)
		expect(useAudioStore.getState().status).toBe("playing")
	})

	it("holds paused when the reload's play() is refused and plays on the next resume", async () => {
		enable()

		const h = makeHarness()
		const { out } = await start(h)
		let wall = 0

		vi.spyOn(Date, "now").mockImplementation(() => wall)
		out.setSample({ currentTimeMs: 120_000, paused: false })
		h.output.state = "suspended"
		out.fire("onTimeUpdate")
		wall = 1_500
		h.nextMainPlay.reject = true
		out.fire("onTimeUpdate")
		await flush()

		const reloaded = h.mains.at(-1)

		expect(reloaded).not.toBe(out)
		expect(useAudioStore.getState().status).toBe("paused")
		expect(useAudioStore.getState().lastError).toBeNull()
		expect(useAudioStore.getState().currentIndex).toBe(0)

		h.engine.resume()
		await flush()

		expect(reloaded?.plays).toBe(2)
		expect(useAudioStore.getState().status).toBe("playing")
	})
})

describe("transition edge cases", () => {
	const silentHead: TrackEdges = {
		status: "ok",
		durationSec: 200,
		inStartMs: 1_500,
		outEndFromEndMs: null,
		fadeOutFromEndMs: null,
		boundary: null
	}

	it("warms the next track when the outgoing ended before the incoming started", async () => {
		enable()

		const h = makeHarness()
		const { out, warm } = await start(h, [track("a"), track("b"), track("c")])
		const control = warm.holdPlay()

		await reachWindow(out)
		out.fire("onEnded")
		control.resolve()
		await flush()

		expect(useAudioStore.getState().currentIndex).toBe(1)
		expect(h.warms.at(-1)?.loads).toEqual(["src:c"])
	})

	it("warms the next track again after a pause dropped the fade", async () => {
		enable()

		const h = makeHarness()
		const { out } = await start(h, [track("a"), track("b"), track("c")])

		await reachWindow(out)
		h.engine.pause()
		await flush()

		expect(out.disposed).toBe(true)
		expect(h.warms.at(-1)?.loads).toEqual(["src:c"])
		expect(h.warms.at(-1)?.disposed).toBe(false)
	})

	it("parks the incoming back at its audio start on a pause", async () => {
		enable()

		const h = makeHarness()

		h.edges.set("b", silentHead)

		const { out, warm } = await start(h)

		await flush()
		out.fire("onTimeUpdate")

		const control = warm.holdPlay()

		await reachWindow(out)
		// The incoming already played a little past its start.
		warm.setSample({ currentTimeMs: 1_900 })
		h.engine.pause()
		control.resolve()
		await flush()

		expect(warm.adapter.sample().currentTimeMs).toBe(1_500)
		expect(warm.disposed).toBe(false)
	})

	it("does not finish a transition into a track a queue edit moved", async () => {
		enable()

		const h = makeHarness()

		await h.engine.enqueueAndPlay([track("x"), track("a"), track("b")], 1)
		await flush()

		const out = h.mains.at(-1)
		const warm = h.warms.at(-1)

		if (out === undefined || warm === undefined) {
			throw new Error("nothing warmed")
		}

		out.setSample({ currentTimeMs: 100_000, durationMs: DURATION_MS })
		out.fire("onTimeUpdate")

		const control = warm.holdPlay()

		await reachWindow(out)
		await h.engine.removeAt(0)
		control.resolve()
		await flush()

		const state = useAudioStore.getState()

		expect(state.queue[state.currentIndex]?.uuid).toBe("a")
		expect(out.disposed).toBe(false)
		expect(warm.disposed).toBe(true)
		expect(h.warms.at(-1)?.loads).toEqual(["src:b"])

		// The transition starts again into the right track.
		out.fire("onTimeUpdate")
		await flush()

		const after = useAudioStore.getState()

		expect(after.queue[after.currentIndex]?.uuid).toBe("b")
	})

	it("keeps playing the outgoing when shuffle changed while the incoming started", async () => {
		enable()

		const h = makeHarness()
		const { out, warm } = await start(h, [track("a"), track("b"), track("c")])
		const control = warm.holdPlay()

		await reachWindow(out)
		h.engine.setShuffleEnabled(true)
		control.resolve()
		await flush()

		expect(useAudioStore.getState().currentIndex).toBe(0)
		expect(out.disposed).toBe(false)
		expect(out.gain?.events.some(event => event.kind === "curve")).toBe(false)
	})

	it("loads the target of a failed short-fade skip cold instead of reviving the old track", async () => {
		enable({ manualTransition: "fade" })

		const h = makeHarness()
		const { warm } = await start(h)
		const control = warm.holdPlay()

		void h.engine.skipNext()
		await flush()
		control.reject(new Error("decode"))
		await flush()

		expect(useAudioStore.getState().currentIndex).toBe(1)
		expect(h.mains.at(-1)?.loads.at(-1)).toBe("src:b")
		expect(useAudioStore.getState().status).toBe("playing")
	})

	it("seeks into the target of a short-fade skip that is still starting", async () => {
		enable({ manualTransition: "fade" })

		const h = makeHarness()
		const { warm } = await start(h)

		warm.holdPlay()
		void h.engine.skipNext()
		await flush()
		h.engine.seek(30)
		await flush()

		const target = h.mains.at(-1)

		expect(target?.loads.at(-1)).toBe("src:b")
		expect(target?.seeks.at(-1)).toBe(30)
		expect(warm.disposed).toBe(true)
	})

	it("starts the output from Try again", async () => {
		enable()

		const h = makeHarness()

		await start(h)
		h.engine.pause()

		const before = h.output.unlocks

		await h.engine.playCurrent()

		expect(h.output.unlocks).toBe(before + 1)
	})

	it("counts a stall on the track before toward a degrade", async () => {
		enable()

		let wall = 0

		vi.spyOn(Date, "now").mockImplementation(() => wall)

		const h = makeHarness()
		const { out, warm } = await start(h)

		h.output.seconds = 10
		out.setSample({ currentTimeMs: 100_000, paused: false })
		out.fire("onTimeUpdate")
		wall = 2_000
		out.setSample({ currentTimeMs: 102_000 })
		out.fire("onTimeUpdate")

		expect(h.output.resumes).toBe(1)

		wall = 2_500
		h.output.seconds = 10.5
		out.setSample({ currentTimeMs: 102_500 })
		out.fire("onTimeUpdate")
		await h.engine.skipNext()
		await flush()

		wall = 3_000
		h.output.seconds = 11
		warm.setSample({ currentTimeMs: 0, paused: false })
		warm.fire("onTimeUpdate")
		wall = 5_100
		h.output.seconds = 11.02
		warm.setSample({ currentTimeMs: 2_100 })
		warm.fire("onTimeUpdate")
		await flush()

		expect(useSmoothTransitionsStore.getState().unavailable).toBe("degraded")
	})

	it("applies ReplayGain tags that arrived after the warm-up when the transition starts", async () => {
		enable({ matchLoudness: true })

		const h = makeHarness()
		const { out, warm } = await start(h)
		const trims = () => warm.gain?.events.filter(event => event.kind === "trim") ?? []

		expect(trims().at(-1)).toEqual({ kind: "trim", value: 10 ** (-6 / 20), ramp: 0 })

		putTrackTags("b", tags({ gain: { trackDb: -2, trackPeak: 0.5, albumDb: null, albumPeak: null } }))
		await reachWindow(out)

		const last = trims().at(-1)

		expect(last?.kind === "trim" && last.value).toBeCloseTo(10 ** (-2 / 20), 5)
	})
})

describe("WebKit output lifetime", () => {
	it("closes the output when the queue ends", async () => {
		enable()

		const h = makeHarness({ webkit: true })

		await h.engine.enqueueAndPlay([track("a")], 0)
		await flush()

		const out = h.mains[0]
		const closes = h.output.closes

		out?.fire("onEnded")
		await flush()

		expect(out?.disposed).toBe(true)
		expect(out?.gain?.released).toBe(true)
		expect(h.output.closes).toBe(closes + 1)

		// The next play reloads the track (and routes it on a new context).
		h.engine.resume()
		await flush()

		expect(h.mains.at(-1)?.loads).toEqual(["src:a"])
	})

	it("closes the output after a long pause and resumes the track where it stood", async () => {
		enable()

		const h = makeHarness({ webkit: true })
		const { out } = await start(h)

		out.setSample({ currentTimeMs: 120_000 })
		h.engine.pause()
		vi.advanceTimersByTime(5 * 60_000)

		expect(out.disposed).toBe(true)

		h.engine.resume()
		await flush()

		const reloaded = h.mains.at(-1)

		expect(reloaded?.loads).toEqual(["src:a"])
		expect(reloaded?.seeks.at(-1)).toBe(120)
	})

	it("keeps the output through a short pause", async () => {
		enable()

		const h = makeHarness({ webkit: true })
		const { out } = await start(h)

		h.engine.pause()
		vi.advanceTimersByTime(60_000)
		h.engine.resume()
		vi.advanceTimersByTime(5 * 60_000)

		expect(out.disposed).toBe(false)
	})
})
