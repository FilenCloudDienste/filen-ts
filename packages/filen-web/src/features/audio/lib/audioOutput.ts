import type { ContextState } from "@/features/audio/lib/outputWatchdog.logic"

// The Web Audio output smooth transitions play through: one lazily created AudioContext, a master gain that follows
// the shared volume, and per element `source → trim (loudness) → fade (automation) → master`. Nothing here exists
// while the feature is off. Structural types stand in for the DOM's, so a test can hand in a fake context.

export interface AudioParamLike {
	setValueAtTime(value: number, time: number): unknown
	setTargetAtTime(target: number, time: number, timeConstant: number): unknown
	linearRampToValueAtTime(value: number, time: number): unknown
	setValueCurveAtTime(values: Float32Array, time: number, duration: number): unknown
	cancelScheduledValues(time: number): unknown
}

export interface AudioNodeLike {
	connect(destination: AudioNodeLike): unknown
	disconnect(destination?: AudioNodeLike): void
}

export interface AnalyserNodeLike extends AudioNodeLike {
	fftSize: number
	getFloatTimeDomainData(array: Float32Array<ArrayBuffer>): void
}

export interface GainNodeLike extends AudioNodeLike {
	gain: AudioParamLike
}

export interface AudioContextLike {
	readonly state: string
	readonly currentTime: number
	readonly destination: AudioNodeLike
	onstatechange: unknown
	resume(): Promise<void>
	suspend(): Promise<void>
	close(): Promise<void>
	createGain(): GainNodeLike
	createAnalyser(): AnalyserNodeLike
	createMediaElementSource(element: HTMLMediaElement): AudioNodeLike
}

// navigator.audioSession (WebKit): "playback" keeps Web Audio rendering where the OS would treat the page as ambient.
export interface AudioSessionLike {
	type: string
}

// One routed element's gains. Times are AudioContext seconds.
export interface ElementGain {
	// The loudness trim, at once (`rampSeconds` 0) or ramped.
	setTrim: (linear: number, rampSeconds: number) => void
	// Cancels any fade automation and holds `value` from now.
	holdFade: (value: number) => void
	// Cancels any fade automation and plays `curve` from `startSeconds` over `durationSeconds`.
	scheduleFade: (curve: Float32Array, startSeconds: number, durationSeconds: number) => void
	// Resolves once the element's sound reaches the graph (or after `timeoutMs`, or on release).
	whenAudible: (timeoutMs: number) => Promise<void>
	release: () => void
}

export interface AudioOutput {
	// Creates or resumes the context. Synchronous, so a click handler calls it inside its gesture.
	unlock: () => void
	// Whether an element routed now would be heard: the context runs, or a gesture just asked it to.
	readonly usable: boolean
	readonly contextSeconds: number
	readonly contextState: ContextState
	readonly selfSuspended: boolean
	readonly routedCount: number
	connect: (element: HTMLMediaElement) => ElementGain | null
	setMaster: (level: number) => void
	// Paused: Chromium and Firefox suspend the context after a while; WebKit keeps it running, its resume can stay silent.
	idle: () => void
	active: () => void
	// The watchdog's one resume.
	resume: () => void
	// Whether the context outlives its last routed element (the feature is on).
	setKeepOpen: (keepOpen: boolean) => void
	// Closes the context once no element is routed to it.
	closeIfUnused: () => void
	close: () => void
	onStateChange: (listener: (() => void) | null) => void
}

export interface AudioOutputDeps {
	createContext: () => AudioContextLike
	audioSession: () => AudioSessionLike | undefined
	webkit: boolean
	warn: (message: string, error?: unknown) => void
}

const IDLE_SUSPEND_MS = 10_000
const AUDIBLE_POLL_MS = 10
const PROBE_SIZE = 256
const MASTER_TIME_CONSTANT = 0.015

function contextState(state: string | undefined): ContextState {
	return state === "running" || state === "suspended" || state === "interrupted" ? state : "closed"
}

class WebAudioOutput implements AudioOutput {
	private readonly deps: AudioOutputDeps
	private context: AudioContextLike | null = null
	private master: GainNodeLike | null = null
	private masterLevel = 1
	private routed = 0
	private keepOpen = false
	private suspendedByUs = false
	private resumePending = false
	private idleTimer: ReturnType<typeof setTimeout> | null = null
	private stateListener: (() => void) | null = null

	public constructor(deps: AudioOutputDeps) {
		this.deps = deps
	}

	public get usable(): boolean {
		return this.context !== null && (this.context.state === "running" || this.resumePending)
	}

	public get contextSeconds(): number {
		return this.context?.currentTime ?? 0
	}

	public get contextState(): ContextState {
		return contextState(this.context?.state)
	}

	public get selfSuspended(): boolean {
		return this.suspendedByUs
	}

	public get routedCount(): number {
		return this.routed
	}

	public unlock(): void {
		this.cancelIdle()

		if (this.context === null) {
			this.create()
		}

		if (this.context !== null && this.context.state !== "running") {
			this.resumeContext()
		}
	}

	private create(): void {
		const session = this.deps.audioSession()

		if (session !== undefined) {
			session.type = "playback"

			if (session.type !== "playback") {
				this.deps.warn(`audio session type reads back as ${session.type}`)
			}
		}

		const context = this.deps.createContext()
		const master = context.createGain()

		master.gain.setValueAtTime(this.masterLevel, context.currentTime)
		master.connect(context.destination)
		context.onstatechange = () => {
			this.stateListener?.()
		}
		this.context = context
		this.master = master
	}

	private resumeContext(): void {
		const context = this.context

		if (context === null) {
			return
		}

		this.resumePending = true
		this.suspendedByUs = false
		context.resume().then(
			() => {
				if (this.context === context) {
					this.resumePending = false
				}
			},
			(error: unknown) => {
				if (this.context === context) {
					this.resumePending = false
				}

				this.deps.warn("audio context resume failed", error)
			}
		)
	}

	public connect(element: HTMLMediaElement): ElementGain | null {
		const context = this.context
		const master = this.master

		if (context === null || master === null) {
			return null
		}

		const source = context.createMediaElementSource(element)
		const trim = context.createGain()
		const fade = context.createGain()
		let released = false
		let trimLevel = 1

		source.connect(trim)
		trim.connect(fade)
		fade.connect(master)
		this.routed++

		return {
			setTrim: (linear, rampSeconds) => {
				const now = context.currentTime

				trim.gain.cancelScheduledValues(now)

				if (rampSeconds > 0) {
					trim.gain.setValueAtTime(trimLevel, now)
					trim.gain.linearRampToValueAtTime(linear, now + rampSeconds)
				} else {
					trim.gain.setValueAtTime(linear, now)
				}

				trimLevel = linear
			},
			holdFade: value => {
				fade.gain.cancelScheduledValues(0)
				fade.gain.setValueAtTime(value, context.currentTime)
			},
			scheduleFade: (curve, startSeconds, durationSeconds) => {
				const start = Math.max(startSeconds, context.currentTime)

				fade.gain.cancelScheduledValues(0)
				fade.gain.setValueAtTime(curve[0] ?? 1, context.currentTime)
				fade.gain.setValueCurveAtTime(curve, start, Math.max(0.001, durationSeconds))
			},
			whenAudible: timeoutMs =>
				new Promise<void>(resolve => {
					const probe = context.createAnalyser()
					const samples = new Float32Array(PROBE_SIZE)
					const deadline = Date.now() + timeoutMs

					probe.fftSize = PROBE_SIZE
					source.connect(probe)

					const check = (): void => {
						probe.getFloatTimeDomainData(samples)

						if (released || Date.now() >= deadline || samples.some(value => value !== 0)) {
							source.disconnect(probe)
							resolve()

							return
						}

						setTimeout(check, AUDIBLE_POLL_MS)
					}

					check()
				}),
			release: () => {
				if (released) {
					return
				}

				released = true
				source.disconnect()
				trim.disconnect()
				fade.disconnect()
				this.routed--

				if (this.routed === 0 && !this.keepOpen) {
					this.close()
				}
			}
		}
	}

	public setMaster(level: number): void {
		this.masterLevel = level

		if (this.context !== null && this.master !== null) {
			this.master.gain.setTargetAtTime(level, this.context.currentTime, MASTER_TIME_CONSTANT)
		}
	}

	public idle(): void {
		if (this.deps.webkit || this.context === null || this.idleTimer !== null) {
			return
		}

		this.idleTimer = setTimeout(() => {
			this.idleTimer = null

			const context = this.context

			if (context?.state !== "running") {
				return
			}

			this.suspendedByUs = true
			context.suspend().catch((error: unknown) => {
				this.deps.warn("audio context suspend failed", error)
			})
		}, IDLE_SUSPEND_MS)
	}

	private cancelIdle(): void {
		if (this.idleTimer !== null) {
			clearTimeout(this.idleTimer)
			this.idleTimer = null
		}
	}

	public active(): void {
		this.cancelIdle()

		if (this.suspendedByUs) {
			this.resumeContext()
		}
	}

	public resume(): void {
		this.resumeContext()
	}

	public setKeepOpen(keepOpen: boolean): void {
		this.keepOpen = keepOpen

		if (!keepOpen) {
			this.closeIfUnused()
		}
	}

	public closeIfUnused(): void {
		if (this.routed === 0) {
			this.close()
		}
	}

	public close(): void {
		this.cancelIdle()

		const context = this.context

		if (context === null) {
			return
		}

		this.context = null
		this.master?.disconnect()
		this.master = null
		this.suspendedByUs = false
		this.resumePending = false
		context.onstatechange = null
		context.close().catch((error: unknown) => {
			this.deps.warn("audio context close failed", error)
		})

		const session = this.deps.audioSession()

		if (session !== undefined) {
			session.type = "auto"
		}
	}

	public onStateChange(listener: (() => void) | null): void {
		this.stateListener = listener
	}
}

export function createAudioOutput(deps: AudioOutputDeps): AudioOutput {
	return new WebAudioOutput(deps)
}
