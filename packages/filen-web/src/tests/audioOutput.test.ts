import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
	createAudioOutput,
	type AudioContextLike,
	type AudioNodeLike,
	type AudioOutputDeps,
	type AudioParamLike,
	type AudioSessionLike,
	type GainNodeLike
} from "@/features/audio/lib/audioOutput"
import { INITIAL_WATCHDOG_STATE, watchdogStep, type WatchdogSample, type WatchdogState } from "@/features/audio/lib/outputWatchdog.logic"

interface ParamCall {
	method: string
	args: unknown[]
}

function fakeParam(calls: ParamCall[]): AudioParamLike {
	const record =
		(method: string) =>
		(...args: unknown[]) => {
			calls.push({ method, args })
		}

	return {
		setValueAtTime: record("setValueAtTime"),
		setTargetAtTime: record("setTargetAtTime"),
		linearRampToValueAtTime: record("linearRampToValueAtTime"),
		setValueCurveAtTime: record("setValueCurveAtTime"),
		cancelScheduledValues: record("cancelScheduledValues")
	}
}

interface FakeContext extends AudioContextLike {
	gains: { node: GainNodeLike; calls: ParamCall[]; disconnected: boolean }[]
	sources: number
	resumes: number
	suspends: number
	// What an analyser on a routed element reads: its sound, once it arrives.
	audible: boolean
	closes: number
	setState: (state: string) => void
}

function fakeContext(initialState = "running"): FakeContext {
	let state = initialState
	// As the real AudioNode: disconnecting from a node it is not connected to throws InvalidAccessError.
	const node = (): AudioNodeLike => {
		const outputs = new Set<AudioNodeLike>()

		return {
			connect: destination => {
				outputs.add(destination)
			},
			disconnect: destination => {
				if (destination === undefined) {
					outputs.clear()

					return
				}

				if (!outputs.delete(destination)) {
					throw new DOMException("not connected", "InvalidAccessError")
				}
			}
		}
	}
	const context: FakeContext = {
		get state() {
			return state
		},
		currentTime: 5,
		destination: node(),
		onstatechange: null,
		gains: [],
		sources: 0,
		resumes: 0,
		suspends: 0,
		audible: false,
		closes: 0,
		setState: next => {
			state = next
		},
		resume: () => {
			context.resumes++
			state = "running"

			return Promise.resolve()
		},
		suspend: () => {
			context.suspends++
			state = "suspended"

			return Promise.resolve()
		},
		close: () => {
			context.closes++
			state = "closed"

			return Promise.resolve()
		},
		createGain: () => {
			const calls: ParamCall[] = []
			const entry = { node: { ...node(), gain: fakeParam(calls) }, calls, disconnected: false }

			entry.node.disconnect = () => {
				entry.disconnected = true
			}
			context.gains.push(entry)

			return entry.node
		},
		createAnalyser: () => ({
			...node(),
			fftSize: 2048,
			getFloatTimeDomainData: array => {
				array.fill(context.audible ? 0.25 : 0)
			}
		}),
		createMediaElementSource: () => {
			context.sources++

			return node()
		}
	}

	return context
}

const element = {} as unknown as HTMLMediaElement

function isListener(value: unknown): value is () => void {
	return typeof value === "function"
}

function setup(overrides: Partial<AudioOutputDeps> = {}, initialState = "running") {
	const contexts: FakeContext[] = []
	const session: AudioSessionLike = { type: "auto" }
	const typesAtCreation: string[] = []
	const output = createAudioOutput({
		createContext: () => {
			typesAtCreation.push(session.type)

			const context = fakeContext(initialState)

			contexts.push(context)

			return context
		},
		audioSession: () => session,
		webkit: false,
		warn: () => undefined,
		...overrides
	})

	return { output, contexts, session, typesAtCreation }
}

describe("AudioOutput", () => {
	beforeEach(() => {
		vi.useFakeTimers()
	})

	afterEach(() => {
		vi.useRealTimers()
	})

	it("creates nothing until unlocked", () => {
		const { output, contexts, session } = setup()

		output.setMaster(0.5)

		expect(contexts).toHaveLength(0)
		expect(output.connect(element)).toBeNull()
		expect(output.usable).toBe(false)
		expect(session.type).toBe("auto")
	})

	it("sets the audio session to playback before the context exists and restores it on close", () => {
		const { output, contexts, session, typesAtCreation } = setup()

		output.unlock()

		expect(typesAtCreation).toEqual(["playback"])
		expect(contexts).toHaveLength(1)

		output.close()

		expect(session.type).toBe("auto")
		expect(contexts[0]?.closes).toBe(1)
	})

	it("works without an audio session", () => {
		const { output, contexts } = setup({ audioSession: () => undefined })

		output.unlock()

		expect(contexts).toHaveLength(1)
	})

	it("routes elements through trim and fade gains into a master that follows the volume", () => {
		const { output, contexts } = setup()

		output.setMaster(0.4)
		output.unlock()

		const context = contexts[0]
		const gain = output.connect(element)

		expect(gain).not.toBeNull()
		expect(context?.sources).toBe(1)
		expect(output.routedCount).toBe(1)

		const master = context?.gains[0]

		expect(master?.calls[0]).toEqual({ method: "setValueAtTime", args: [0.4, 5] })

		output.setMaster(0.7)

		expect(master?.calls.at(-1)).toEqual({ method: "setTargetAtTime", args: [0.7, 5, 0.015] })
	})

	it("ramps the trim and replaces any fade automation", () => {
		const { output, contexts } = setup()

		output.unlock()

		const gain = output.connect(element)
		const trim = contexts[0]?.gains[1]
		const fade = contexts[0]?.gains[2]

		gain?.setTrim(0.5, 0.2)

		expect(trim?.calls.map(call => call.method)).toEqual(["cancelScheduledValues", "setValueAtTime", "linearRampToValueAtTime"])

		const curve = new Float32Array([1, 0.5, 0])

		gain?.scheduleFade(curve, 6, 3)

		expect(fade?.calls.map(call => call.method)).toEqual(["cancelScheduledValues", "setValueAtTime", "setValueCurveAtTime"])
		expect(fade?.calls.at(-1)?.args).toEqual([curve, 6, 3])
	})

	it("closes once the last routed element goes while the feature is off, not while it is on", () => {
		const { output, contexts } = setup()

		output.unlock()
		output.setKeepOpen(true)

		const first = output.connect(element)

		first?.release()

		expect(contexts[0]?.closes).toBe(0)

		const second = output.connect(element)

		output.setKeepOpen(false)

		expect(contexts[0]?.closes).toBe(0)

		second?.release()
		second?.release()

		expect(contexts[0]?.closes).toBe(1)
		expect(output.routedCount).toBe(0)
	})

	it("suspends 10 s after a pause on Chromium and Firefox, and resumes on play", () => {
		const { output, contexts } = setup()

		output.unlock()
		output.idle()
		vi.advanceTimersByTime(9_999)

		expect(contexts[0]?.suspends).toBe(0)

		vi.advanceTimersByTime(1)

		expect(contexts[0]?.suspends).toBe(1)
		expect(output.selfSuspended).toBe(true)

		output.active()

		expect(contexts[0]?.resumes).toBe(1)
		expect(output.selfSuspended).toBe(false)
	})

	it("never suspends itself on WebKit", () => {
		const { output, contexts } = setup({ webkit: true })

		output.unlock()
		output.idle()
		vi.advanceTimersByTime(60_000)

		expect(contexts[0]?.suspends).toBe(0)
	})

	it("is usable while a gesture's resume is pending, not on a stopped context", async () => {
		const { output, contexts } = setup({}, "suspended")

		output.unlock()

		expect(output.usable).toBe(true)

		await Promise.resolve()

		expect(contexts[0]?.state).toBe("running")

		contexts[0]?.setState("suspended")

		expect(output.usable).toBe(false)
	})

	it("settles a pending wait false when the element is released, without touching the released nodes", async () => {
		const { output } = setup()

		output.unlock()

		const gain = output.connect(element)
		const results: boolean[] = []

		void gain?.whenAudible(600).then(heard => {
			results.push(heard)
		})
		vi.advanceTimersByTime(30)
		gain?.release()
		await Promise.resolve()

		expect(results).toEqual([false])
		expect(() => vi.advanceTimersByTime(1_000)).not.toThrow()
		expect(await gain?.whenAudible(600)).toBe(false)
	})

	it("waits until a routed element is heard, or gives up after the timeout", async () => {
		const { output, contexts } = setup()

		output.unlock()

		const gain = output.connect(element)
		let heard = false

		void gain?.whenAudible(600).then(() => {
			heard = true
		})
		vi.advanceTimersByTime(100)
		await Promise.resolve()

		expect(heard).toBe(false)

		const context = contexts[0]

		if (context !== undefined) {
			context.audible = true
		}

		vi.advanceTimersByTime(10)
		await Promise.resolve()

		expect(heard).toBe(true)

		let timedOut = false

		if (context !== undefined) {
			context.audible = false
		}

		void gain?.whenAudible(200).then(() => {
			timedOut = true
		})
		vi.advanceTimersByTime(250)
		await Promise.resolve()

		expect(timedOut).toBe(true)
	})

	it("reports state changes to its listener", () => {
		const { output, contexts } = setup()
		const listener = vi.fn()

		output.onStateChange(listener)
		output.unlock()

		const handler = contexts[0]?.onstatechange

		if (!isListener(handler)) {
			throw new Error("no state listener")
		}

		handler()

		expect(listener).toHaveBeenCalledTimes(1)
	})
})

describe("watchdogStep", () => {
	function sample(overrides: Partial<WatchdogSample>): WatchdogSample {
		return {
			wallMs: 0,
			contextSeconds: 0,
			elementMs: 0,
			contextState: "running",
			wantPlaying: true,
			selfSuspended: false,
			...overrides
		}
	}

	function run(samples: Partial<WatchdogSample>[]): string[] {
		let state: WatchdogState = INITIAL_WATCHDOG_STATE

		return samples.map(next => {
			const step = watchdogStep(state, sample(next))

			state = step.state

			return step.action
		})
	}

	it("leaves a healthy clock alone", () => {
		expect(
			run([
				{ wallMs: 0, contextSeconds: 0, elementMs: 0 },
				{ wallMs: 2_000, contextSeconds: 2, elementMs: 2_000 },
				{ wallMs: 4_000, contextSeconds: 4, elementMs: 4_000 }
			])
		).toEqual(["ok", "ok", "ok"])
	})

	it("resumes a context suspended or interrupted behind the engine's back, then degrades if it stays down", () => {
		expect(
			run([{ contextState: "suspended" }, { wallMs: 500, contextState: "suspended" }, { wallMs: 1_200, contextState: "suspended" }])
		).toEqual(["resume", "ok", "degrade"])
		expect(run([{ contextState: "interrupted" }, { wallMs: 400, contextState: "running", contextSeconds: 0.4 }])).toEqual([
			"resume",
			"ok"
		])
	})

	it("ignores a context it suspended itself, and a paused engine", () => {
		expect(
			run([
				{ contextState: "suspended", selfSuspended: true },
				{ contextState: "suspended", wantPlaying: false }
			])
		).toEqual(["ok", "ok"])
	})

	it("treats a clock standing still under a playing element as a stall, and a second stall within a minute as fatal", () => {
		expect(
			run([
				{ wallMs: 0, contextSeconds: 10, elementMs: 0 },
				{ wallMs: 2_000, contextSeconds: 10.05, elementMs: 2_000 },
				{ wallMs: 2_500, contextSeconds: 10.5, elementMs: 2_500 },
				{ wallMs: 4_600, contextSeconds: 10.55, elementMs: 4_600 }
			])
		).toEqual(["ok", "resume", "ok", "degrade"])
	})

	it("degrades when a stall's resume does not bring the clock back", () => {
		expect(
			run([
				{ wallMs: 0, contextSeconds: 10, elementMs: 0 },
				{ wallMs: 2_000, contextSeconds: 10, elementMs: 2_000 },
				{ wallMs: 3_100, contextSeconds: 10.01, elementMs: 3_100 }
			])
		).toEqual(["ok", "resume", "degrade"])
	})

	it("forgives a stall a minute later", () => {
		expect(
			run([
				{ wallMs: 0, contextSeconds: 10, elementMs: 0 },
				{ wallMs: 2_000, contextSeconds: 10, elementMs: 2_000 },
				{ wallMs: 2_500, contextSeconds: 10.5, elementMs: 2_500 },
				{ wallMs: 70_000, contextSeconds: 78, elementMs: 70_000 },
				{ wallMs: 72_000, contextSeconds: 78, elementMs: 72_000 }
			])
		).toEqual(["ok", "resume", "ok", "ok", "resume"])
	})

	it("does not mistake a seek forward for a stall", () => {
		expect(
			run([
				{ wallMs: 0, contextSeconds: 10, elementMs: 0 },
				{ wallMs: 2_000, contextSeconds: 12, elementMs: 60_000 }
			])
		).toEqual(["ok", "ok"])
	})
})
