import { useEffect, useState, useSyncExternalStore } from "react"
import { Button } from "@/components/ui/button"
import { audioEngine } from "@/features/audio/lib/audioEngine"
import { resolveTrackSource } from "@/features/audio/lib/bytes"
import type { TrackSource } from "@/features/audio/lib/engine"
import type { QueueTrack } from "@/features/audio/store/audioQueue"
import { useAudioStore } from "@/features/audio/store/useAudioStore"
import { isMediaStreamAvailable } from "@/features/preview/lib/previewStream"
import { mediaSessionOwners, type MediaSessionOwner } from "@/lib/media/mediaSessionOwner"

// Throwaway hardware gate for smooth transitions on a locked iPhone: two queue tracks streamed through the service
// worker's range route, routed element → gain → destination on one AudioContext, crossfading every 30 s for as long
// as it runs, with a clock-stall watchdog and an on-screen log. Built only with VITE_SMOOTH_TRANSITIONS_SPIKE=1.

const FADE_EVERY_SECONDS = 30
const FADE_SECONDS = 6
const CURVE_POINTS = 64
const WATCHDOG_MS = 2_000
const TICK_MS = 500
const STALL_ELEMENT_SECONDS = 1.5
const STALL_CONTEXT_SECONDS = 0.1
const MAX_LOG_LINES = 3_000

type Phase = "idle" | "preparing" | "ready" | "running" | "failed"

interface SpikeSnapshot {
	phase: Phase
	lines: string[]
	crossfades: number
	stalls: number
	contextState: string
	audioSession: string
	tracks: string[]
}

interface Deck {
	label: "A" | "B"
	track: QueueTrack
	source: TrackSource
	element: HTMLAudioElement
	gain: GainNode | null
}

interface WatchdogSample {
	wall: number
	context: number
	element: number
	deck: Deck
}

// Equal-power curves: cos for the outgoing deck, sin for the incoming, summing to constant power.
function equalPowerCurve(fadeIn: boolean): Float32Array {
	const curve = new Float32Array(CURVE_POINTS)

	for (let i = 0; i < CURVE_POINTS; i++) {
		const angle = (i / (CURVE_POINTS - 1)) * (Math.PI / 2)

		curve[i] = fadeIn ? Math.sin(angle) : Math.cos(angle)
	}

	return curve
}

function clock(): string {
	const now = new Date()
	const pad = (value: number, width: number) => String(value).padStart(width, "0")

	return `${pad(now.getHours(), 2)}:${pad(now.getMinutes(), 2)}:${pad(now.getSeconds(), 2)}.${pad(now.getMilliseconds(), 3)}`
}

function errorText(error: unknown): string {
	return error instanceof Error ? `${error.name}: ${error.message}` : String(error)
}

// navigator.audioSession is WebKit-only and missing from the DOM lib.
function audioSessionOf(nav: Navigator): { type: unknown } | null {
	if (!("audioSession" in nav)) {
		return null
	}

	const session = nav.audioSession

	return typeof session === "object" && session !== null && "type" in session ? session : null
}

class SmoothTransitionsSpikeRunner {
	private snapshot: SpikeSnapshot = {
		phase: "idle",
		lines: [],
		crossfades: 0,
		stalls: 0,
		contextState: "none",
		audioSession: "not set",
		tracks: []
	}
	private readonly listeners = new Set<() => void>()
	private generation = 0
	private decks: Deck[] = []
	private context: AudioContext | null = null
	private owner: MediaSessionOwner | null = null
	private active = 0
	private fading: { from: Deck; to: Deck; timer: ReturnType<typeof setTimeout> } | null = null
	private wantPlaying = false
	private resumeTried = false
	private lastSample: WatchdogSample | null = null
	private timers: ReturnType<typeof setInterval>[] = []
	private unbinds: (() => void)[] = []

	public subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener)

		return () => {
			this.listeners.delete(listener)
		}
	}

	public getSnapshot = (): SpikeSnapshot => this.snapshot

	public log = (message: string): void => {
		const lines =
			this.snapshot.lines.length >= MAX_LOG_LINES ? this.snapshot.lines.slice(-MAX_LOG_LINES + 1) : this.snapshot.lines.slice()

		lines.push(`${clock()} ${message}`)
		console.info(`[smooth-transitions-spike] ${message}`)
		this.update({ lines })
	}

	public copyLog = (): void => {
		const text = this.snapshot.lines.join("\n")

		navigator.clipboard.writeText(text).then(
			() => {
				this.log(`log copied (${String(this.snapshot.lines.length)} lines)`)
			},
			(error: unknown) => {
				this.log(`copy failed: ${errorText(error)}`)
			}
		)
	}

	// Resolves the first two queue tracks through the audio player's own source resolver (the SW range route).
	public prepare = async (): Promise<void> => {
		this.teardown()

		const generation = ++this.generation
		const queue = useAudioStore.getState().queue

		this.update({ phase: "preparing", crossfades: 0, stalls: 0, contextState: "none", audioSession: "not set", tracks: [] })
		this.log(`queue has ${String(queue.length)} track(s); user agent: ${navigator.userAgent}`)

		if (queue.length < 2) {
			this.fail("need at least two tracks in the audio queue: queue two tracks in the player, then come back here")

			return
		}

		if (!isMediaStreamAvailable()) {
			this.fail("SW route unavailable: no service worker controls this page (needs a secure context and a reload)")

			return
		}

		audioEngine.pause()
		this.log("audio player paused")

		const tracks = queue.slice(0, 2)
		const abort = new AbortController()
		const decks: Deck[] = []

		this.unbinds.push(() => {
			abort.abort()

			for (const deck of decks) {
				deck.element.removeAttribute("src")
				deck.source.release()
			}
		})

		for (const [index, track] of tracks.entries()) {
			const label = index === 0 ? "A" : "B"

			try {
				const source = await resolveTrackSource(track, abort.signal)

				if (generation !== this.generation) {
					source.release()

					return
				}

				this.describeSource(label, track, source)

				decks.push(this.createDeck(label, track, source))
			} catch (error) {
				if (generation === this.generation) {
					this.fail(`resolving ${label} failed: ${errorText(error)}`)
				}

				return
			}
		}

		// Teardown releases this.decks' sources from here on.
		this.decks = decks.splice(0)

		if (this.decks.some(deck => deck.source.media.kind !== "url")) {
			this.fail("a source is a MediaSource session, not the SW route: stopping")

			return
		}

		this.update({ phase: "ready", tracks: this.decks.map(deck => `${deck.label}: ${deck.track.name}`) })
		this.log("ready: tap Start")
	}

	// The tap: every call that needs a user gesture runs synchronously in here, before any await.
	public start = (): void => {
		const [first, second] = this.decks

		if (this.snapshot.phase !== "ready" || first === undefined || second === undefined) {
			return
		}

		const session = audioSessionOf(navigator)

		if (session === null) {
			this.log("navigator.audioSession: not present")
			this.update({ audioSession: "not present" })
		} else {
			session.type = "playback"

			const readBack = String(session.type)

			this.log(`navigator.audioSession.type set to "playback", reads back "${readBack}"`)
			this.update({ audioSession: readBack })
		}

		const context = new AudioContext({ latencyHint: "playback" })

		this.context = context
		this.log(
			`AudioContext created: state=${context.state} sampleRate=${String(context.sampleRate)} baseLatency=${context.baseLatency.toFixed(4)}`
		)
		this.update({ contextState: context.state })
		context.addEventListener("statechange", this.onContextState)
		this.unbinds.push(() => {
			context.removeEventListener("statechange", this.onContextState)
		})

		for (const deck of this.decks) {
			const gain = context.createGain()

			gain.gain.value = deck === first ? 1 : 0
			context.createMediaElementSource(deck.element).connect(gain)
			gain.connect(context.destination)
			deck.gain = gain
		}

		this.log("graph: MediaElementAudioSourceNode → GainNode → destination for A and B")
		this.bindMediaSession()
		this.wantPlaying = true
		this.active = 0
		this.update({ phase: "running" })

		void context.resume().then(
			() => {
				this.log(`resume() in tap resolved: state=${context.state}`)
			},
			(error: unknown) => {
				this.log(`resume() in tap rejected: ${errorText(error)}`)
			}
		)

		first.element.currentTime = 0
		this.playDeck(first, "start")
		// Unlocks B for the later, gesture-less fade starts; its gain is 0, so this is silent.
		second.element.play().catch((error: unknown) => {
			this.log(`B unlock play() settled: ${errorText(error)}`)
		})
		second.element.pause()
		this.publishMetadata(first)

		this.timers.push(setInterval(this.tick, TICK_MS), setInterval(this.watchdog, WATCHDOG_MS))
	}

	public dispose = (): void => {
		this.generation++
		this.teardown()
	}

	private update(patch: Partial<SpikeSnapshot>): void {
		this.snapshot = { ...this.snapshot, ...patch }

		for (const listener of this.listeners) {
			listener()
		}
	}

	private fail(message: string): void {
		this.log(`STOP: ${message}`)
		this.update({ phase: "failed" })
	}

	private createDeck(label: "A" | "B", track: QueueTrack, source: TrackSource): Deck {
		const element = document.createElement("audio")

		element.preload = "auto"

		const deck: Deck = { label, track, source, element, gain: null }

		for (const type of ["play", "playing", "pause", "waiting", "stalled", "ended", "error", "loadedmetadata"] as const) {
			const listener = () => {
				this.onElementEvent(deck, type)
			}

			element.addEventListener(type, listener)
			this.unbinds.push(() => {
				element.removeEventListener(type, listener)
			})
		}

		element.addEventListener("timeupdate", this.tick)
		this.unbinds.push(() => {
			element.removeEventListener("timeupdate", this.tick)
		})

		if (source.media.kind === "url") {
			element.src = source.media.url
		}

		return deck
	}

	private describeSource(label: string, track: QueueTrack, source: TrackSource): void {
		if (source.media.kind !== "url") {
			this.log(`${label}: "${track.name}" resolved to a MediaSource session (not the SW route)`)

			return
		}

		const url = new URL(source.media.url, location.href)
		const sameOrigin = url.origin === location.origin
		const route = track.contentType === null ? "decoded WAV via SW" : `SW range route as ${track.contentType}`

		this.log(`${label}: "${track.name}" → ${route}, ${url.pathname}, sameOrigin=${String(sameOrigin)}`)
	}

	private onElementEvent(deck: Deck, type: string): void {
		const element = deck.element

		if (type === "error") {
			this.log(`${deck.label} error: code=${String(element.error?.code ?? "?")} ${element.error?.message ?? ""}`)

			return
		}

		this.log(`${deck.label} ${type} t=${element.currentTime.toFixed(2)} duration=${element.duration.toFixed(2)}`)

		if (type === "ended" && this.decks[this.active] === deck && this.fading === null && this.wantPlaying) {
			this.log(`${deck.label} ended before its fade: starting the next deck now`)
			this.startFade("ended")
		}
	}

	private onContextState = (): void => {
		const context = this.context

		if (context === null) {
			return
		}

		const state: string = context.state

		this.log(`ctx statechange → ${state} (currentTime=${context.currentTime.toFixed(2)})`)
		this.update({ contextState: state })

		if (state === "running") {
			this.resumeTried = false

			return
		}

		if ((state === "suspended" || state === "interrupted") && this.wantPlaying && !this.resumeTried) {
			this.resumeTried = true
			this.log("watchdog: trying one resume()")
			context.resume().then(
				() => {
					this.log(`watchdog resume() resolved: state=${context.state}`)
				},
				(error: unknown) => {
					this.log(`watchdog resume() rejected: ${errorText(error)}`)
				}
			)
		}
	}

	// Decides the fade start from the active element's own clock; runs on timeupdate and on a timer.
	private tick = (): void => {
		const deck = this.decks[this.active]

		if (deck === undefined || this.fading !== null || !this.wantPlaying || deck.element.paused) {
			return
		}

		const duration = deck.element.duration
		const fadeAt =
			Number.isFinite(duration) && duration > FADE_SECONDS + 1
				? Math.min(FADE_EVERY_SECONDS, duration - FADE_SECONDS)
				: FADE_EVERY_SECONDS

		// Every incoming deck restarts at 0, so its own time is the time since its fade started.
		if (deck.element.currentTime >= fadeAt) {
			this.startFade("timer")
		}
	}

	private watchdog = (): void => {
		const context = this.context
		const deck = this.decks[this.active]

		if (context === null || deck === undefined) {
			return
		}

		const sample: WatchdogSample = { wall: performance.now(), context: context.currentTime, element: deck.element.currentTime, deck }
		const last = this.lastSample

		this.lastSample = sample

		if (last === null) {
			return
		}

		const wall = (sample.wall - last.wall) / 1000
		const contextDelta = sample.context - last.context
		const elementDelta = last.deck === deck ? sample.element - last.element : Number.NaN
		const stall = elementDelta > STALL_ELEMENT_SECONDS && contextDelta < STALL_CONTEXT_SECONDS

		this.log(
			`wd wall=${wall.toFixed(2)} ctx=${context.state} ctxΔ=${contextDelta.toFixed(2)} ${deck.label}Δ=${Number.isNaN(elementDelta) ? "swap" : elementDelta.toFixed(2)} paused=${String(deck.element.paused)} vis=${document.visibilityState}${stall ? " STALL" : ""}`
		)

		if (stall) {
			this.update({ stalls: this.snapshot.stalls + 1 })
		}
	}

	private startFade(reason: string): void {
		const context = this.context
		const from = this.decks[this.active]
		const to = this.decks[1 - this.active]

		if (context === null || from === undefined || to === undefined || from.gain === null || to.gain === null || this.fading !== null) {
			return
		}

		const fromGain = from.gain.gain
		const toGain = to.gain.gain
		const timer = setTimeout(
			() => {
				this.finishFade()
			},
			FADE_SECONDS * 1000 + 100
		)

		this.fading = { from, to, timer }
		this.log(`fade #${String(this.snapshot.crossfades + 1)} ${from.label}→${to.label} (${reason}), ${to.label} restarts at 0`)
		to.element.currentTime = 0
		toGain.cancelScheduledValues(0)
		toGain.setValueAtTime(0, context.currentTime)

		const play = to.element.play()

		play.then(
			() => {
				if (this.fading?.to !== to) {
					return
				}

				const at = context.currentTime + 0.02

				fromGain.cancelScheduledValues(at)
				toGain.cancelScheduledValues(at)
				fromGain.setValueCurveAtTime(equalPowerCurve(false), at, FADE_SECONDS)
				toGain.setValueCurveAtTime(equalPowerCurve(true), at, FADE_SECONDS)
				this.log(
					`curves scheduled at ctx=${at.toFixed(2)} for ${String(FADE_SECONDS)} s; ${to.label} at t=${to.element.currentTime.toFixed(2)}`
				)
				this.publishMetadata(to)
			},
			(error: unknown) => {
				this.log(`${to.label} play() for the fade rejected: ${errorText(error)}`)
			}
		)
	}

	private finishFade(): void {
		const fading = this.fading

		if (fading === null) {
			return
		}

		clearTimeout(fading.timer)
		this.fading = null
		fading.from.element.pause()
		fading.from.gain?.gain.cancelScheduledValues(0)
		fading.from.gain?.gain.setValueAtTime(0, this.context?.currentTime ?? 0)
		fading.to.gain?.gain.cancelScheduledValues(0)
		fading.to.gain?.gain.setValueAtTime(1, this.context?.currentTime ?? 0)
		this.active = this.decks.indexOf(fading.to)
		this.update({ crossfades: this.snapshot.crossfades + 1 })
		this.log(`fade done: ${fading.to.label} active, crossfades=${String(this.snapshot.crossfades)}`)
	}

	private playDeck(deck: Deck, reason: string): void {
		deck.element.play().then(
			() => {
				this.log(`${deck.label} play() resolved (${reason})`)
			},
			(error: unknown) => {
				this.log(`${deck.label} play() rejected (${reason}): ${errorText(error)}`)
			}
		)
	}

	private bindMediaSession(): void {
		const owner = mediaSessionOwners.create("smoothTransitionsSpike")

		this.owner = owner
		owner.acquire()
		owner.setActionHandler("play", () => {
			this.log("media session: play")
			this.resume()
		})
		owner.setActionHandler("pause", () => {
			this.log("media session: pause")
			this.pause()
		})
		owner.setActionHandler("nexttrack", () => {
			this.log("media session: nexttrack")

			if (!this.wantPlaying) {
				this.resume()
			}

			this.startFade("nexttrack")
		})
		owner.setActionHandler("previoustrack", null)
		owner.setActionHandler("seekto", null)
		owner.setActionHandler("seekbackward", null)
		owner.setActionHandler("seekforward", null)
	}

	private resume(): void {
		const context = this.context
		const deck = this.decks[this.active]

		if (context === null || deck === undefined) {
			return
		}

		this.wantPlaying = true
		this.resumeTried = false
		this.log(`resume: ctx=${context.state} ctxTime=${context.currentTime.toFixed(2)}`)

		if (context.state !== "running") {
			void context.resume().then(
				() => {
					this.log(`resume() resolved: state=${context.state}`)
				},
				(error: unknown) => {
					this.log(`resume() rejected: ${errorText(error)}`)
				}
			)
		}

		this.playDeck(deck, "resume")
		this.owner?.setPlaybackState("playing")
		this.publishPosition(deck)
	}

	// A pause mid-fade lands the fade first: the gain curves run on the context clock, not the elements'.
	private pause(): void {
		this.wantPlaying = false

		if (this.fading !== null) {
			this.log("pause mid-fade: completing the fade now")
			this.finishFade()
		}

		for (const deck of this.decks) {
			deck.element.pause()
		}

		this.owner?.setPlaybackState("paused")

		const deck = this.decks[this.active]

		if (deck !== undefined) {
			this.publishPosition(deck)
		}
	}

	private publishMetadata(deck: Deck): void {
		const owner = this.owner

		if (owner === null || typeof MediaMetadata === "undefined") {
			return
		}

		owner.setMetadata(new MediaMetadata({ title: `${deck.label}: ${deck.track.name}`, artist: "Smooth transitions spike" }))
		owner.setPlaybackState("playing")
		this.publishPosition(deck)
		this.log(`media session metadata → ${deck.label}: ${deck.track.name}`)
	}

	private publishPosition(deck: Deck): void {
		const duration = deck.element.duration

		if (!Number.isFinite(duration) || duration <= 0) {
			return
		}

		this.owner?.setPositionState({ duration, position: Math.min(deck.element.currentTime, duration), playbackRate: 1 })
	}

	private teardown(): void {
		for (const timer of this.timers) {
			clearInterval(timer)
		}

		this.timers = []

		if (this.fading !== null) {
			clearTimeout(this.fading.timer)
			this.fading = null
		}

		for (const unbind of this.unbinds) {
			unbind()
		}

		this.unbinds = []

		for (const deck of this.decks) {
			deck.element.pause()
			deck.element.removeAttribute("src")
			deck.element.load()
			deck.source.release()
		}

		this.decks = []
		this.wantPlaying = false
		this.lastSample = null

		if (this.context !== null) {
			this.context.close().catch((error: unknown) => {
				this.log(`close() rejected: ${errorText(error)}`)
			})
			this.context = null
		}

		const session = audioSessionOf(navigator)

		if (session !== null && this.snapshot.audioSession !== "not set") {
			session.type = "auto"
		}

		this.owner?.release()
		this.owner = null
	}
}

const PHASE_TEXT: Record<Phase, string> = {
	idle: "Idle",
	preparing: "Resolving the first two queue tracks…",
	ready: "Ready",
	running: "Running",
	failed: "Stopped (see log)"
}

export function SmoothTransitionsSpike() {
	const [runner] = useState(() => new SmoothTransitionsSpikeRunner())
	const snapshot = useSyncExternalStore(runner.subscribe, runner.getSnapshot)

	useEffect(() => {
		void runner.prepare()

		return () => {
			runner.dispose()
		}
	}, [runner])

	return (
		<div className="flex h-full min-h-0 flex-col gap-3 overflow-hidden p-4">
			<div className="flex flex-col gap-1 text-sm">
				<h1 className="text-lg font-semibold">Smooth transitions hardware gate</h1>
				<span>Phase: {PHASE_TEXT[snapshot.phase]}</span>
				<span>Crossfades: {snapshot.crossfades}</span>
				<span>Clock stalls: {snapshot.stalls}</span>
				<span>AudioContext: {snapshot.contextState}</span>
				<span>audioSession.type: {snapshot.audioSession}</span>
				{snapshot.tracks.map(track => (
					<span
						key={track}
						className="truncate"
					>
						{track}
					</span>
				))}
			</div>
			<Button
				className="h-16 text-lg"
				disabled={snapshot.phase !== "ready"}
				onClick={runner.start}
			>
				Start
			</Button>
			<div className="flex gap-2">
				<Button
					variant="outline"
					onClick={runner.copyLog}
				>
					Copy log
				</Button>
				<Button
					variant="outline"
					disabled={snapshot.phase === "preparing"}
					onClick={() => {
						void runner.prepare()
					}}
				>
					Reset
				</Button>
			</div>
			<div className="flex min-h-0 flex-1 flex-col-reverse overflow-auto rounded-md border p-2">
				<pre className="font-mono text-[11px] leading-4 break-all whitespace-pre-wrap">{snapshot.lines.join("\n")}</pre>
			</div>
		</div>
	)
}
