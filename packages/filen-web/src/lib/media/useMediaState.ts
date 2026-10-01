import { useEffect, useSyncExternalStore } from "react"
import { adoptMediaVolume, useMediaVolumeStore, warmMediaVolume, type MediaVolume } from "@/lib/media/mediaVolume"

// Reads of a media element's state, re-rendering only the component that asks and only when the value it
// reads changes. Events are coalesced to one notification per animation frame, so a burst (timeupdate +
// progress + seeked) costs a single read.

type MediaSnapshot = string | number | boolean

// A read of one element value, taken once per notification. WebKit answers a playing element's
// currentTime from the live clock, so no two reads agree even within a task; useSyncExternalStore takes
// each difference for a store change and re-renders until React aborts (Maximum update depth exceeded).
// Snapshots are therefore held per element until one of `events` fires.
export interface MediaValue<T extends MediaSnapshot> {
	events: readonly string[]
	read: (media: HTMLMediaElement) => T
	snapshots: WeakMap<HTMLMediaElement, T>
}

export function mediaValue<T extends MediaSnapshot>(events: readonly string[], read: (media: HTMLMediaElement) => T): MediaValue<T> {
	return { events, read, snapshots: new WeakMap() }
}

function readSnapshot<T extends MediaSnapshot>(media: HTMLMediaElement, value: MediaValue<T>): T {
	const cached = value.snapshots.get(media)

	if (cached !== undefined) {
		return cached
	}

	const fresh = value.read(media)

	value.snapshots.set(media, fresh)

	return fresh
}

function subscribeCoalesced<T extends MediaSnapshot>(media: HTMLMediaElement, value: MediaValue<T>, notify: () => void): () => void {
	let frame = 0

	function onEvent(): void {
		if (frame === 0) {
			frame = requestAnimationFrame(() => {
				frame = 0
				value.snapshots.delete(media)
				notify()
			})
		}
	}

	for (const event of value.events) {
		media.addEventListener(event, onEvent)
	}

	// A change between the render and this subscription went unobserved.
	onEvent()

	return () => {
		cancelAnimationFrame(frame)

		for (const event of value.events) {
			media.removeEventListener(event, onEvent)
		}
	}
}

// `value` is a module constant at every call site, so the subscription holds for the element's life.
export function useMediaValue<T extends MediaSnapshot>(media: HTMLMediaElement | null, value: MediaValue<T>, fallback: T): T {
	return useSyncExternalStore(
		notify => (media === null ? () => undefined : subscribeCoalesced(media, value, notify)),
		() => (media === null ? fallback : readSnapshot(media, value)),
		() => fallback
	)
}

const TIME_EVENTS = ["timeupdate", "seeking", "seeked", "durationchange", "loadedmetadata", "emptied"] as const
const DURATION_EVENTS = ["durationchange", "loadedmetadata", "emptied"] as const
const PAUSED_EVENTS = ["play", "pause", "ended", "emptied", "loadstart"] as const
const WAITING_EVENTS = [
	"waiting",
	"playing",
	"canplay",
	"canplaythrough",
	"loadeddata",
	"seeking",
	"seeked",
	"pause",
	"play",
	"emptied"
] as const
const BUFFERED_EVENTS = ["progress", "durationchange", "loadedmetadata", "emptied", "seeked"] as const
const RATE_EVENTS = ["ratechange", "loadedmetadata"] as const
const PIP_EVENTS = ["enterpictureinpicture", "leavepictureinpicture"] as const

function readCurrentTime(media: HTMLMediaElement): number {
	return media.currentTime
}

function readWholeSecond(media: HTMLMediaElement): number {
	return Math.floor(media.currentTime)
}

// 0 until known: a live stream or an unloaded element reports Infinity or NaN.
function mediaDuration(media: HTMLMediaElement): number {
	return Number.isFinite(media.duration) && media.duration > 0 ? media.duration : 0
}

function readPaused(media: HTMLMediaElement): boolean {
	return media.paused
}

// Playing, or asked to, but short of data to continue: HAVE_FUTURE_DATA is the least a player can go on.
function readWaiting(media: HTMLMediaElement): boolean {
	return media.seeking || (!media.paused && media.readyState < HTMLMediaElement.HAVE_FUTURE_DATA)
}

// Serialized so the snapshot stays a primitive; parseBufferedRanges reads it back.
function readBuffered(media: HTMLMediaElement): string {
	const ranges: string[] = []

	for (let i = 0; i < media.buffered.length; i++) {
		ranges.push(`${String(media.buffered.start(i))}~${String(media.buffered.end(i))}`)
	}

	return ranges.join(",")
}

function readRate(media: HTMLMediaElement): number {
	return media.playbackRate
}

function readPictureInPicture(media: HTMLMediaElement): boolean {
	return typeof document !== "undefined" && document.pictureInPictureElement === media
}

const CURRENT_TIME = mediaValue(TIME_EVENTS, readCurrentTime)
const CLOCK_SECONDS = mediaValue(TIME_EVENTS, readWholeSecond)
const DURATION = mediaValue(DURATION_EVENTS, mediaDuration)
const PAUSED = mediaValue(PAUSED_EVENTS, readPaused)
const WAITING = mediaValue(WAITING_EVENTS, readWaiting)
const BUFFERED = mediaValue(BUFFERED_EVENTS, readBuffered)
const RATE = mediaValue(RATE_EVENTS, readRate)
const PICTURE_IN_PICTURE = mediaValue(PIP_EVENTS, readPictureInPicture)

export function useMediaCurrentTime(media: HTMLMediaElement | null): number {
	return useMediaValue(media, CURRENT_TIME, 0)
}

// The playhead in whole seconds, for a clock readout that only changes once a second.
export function useMediaClockSeconds(media: HTMLMediaElement | null): number {
	return useMediaValue(media, CLOCK_SECONDS, 0)
}

export function useMediaDuration(media: HTMLMediaElement | null): number {
	return useMediaValue(media, DURATION, 0)
}

export function useMediaPaused(media: HTMLMediaElement | null): boolean {
	return useMediaValue(media, PAUSED, true)
}

export function useMediaWaiting(media: HTMLMediaElement | null): boolean {
	return useMediaValue(media, WAITING, false)
}

export function useMediaBuffered(media: HTMLMediaElement | null): string {
	return useMediaValue(media, BUFFERED, "")
}

export function useMediaPlaybackRate(media: HTMLMediaElement | null): number {
	return useMediaValue(media, RATE, 1)
}

export function useMediaPictureInPicture(media: HTMLMediaElement | null): boolean {
	return useMediaValue(media, PICTURE_IN_PICTURE, false)
}

// Starts playback, leaving the element paused where the browser refuses (an autoplay policy).
export function playMedia(media: HTMLMediaElement): void {
	void media.play().catch(() => undefined)
}

export function toggleMediaPlayback(media: HTMLMediaElement): void {
	if (media.paused || media.ended) {
		playMedia(media)
	} else {
		media.pause()
	}
}

export function setPlaybackRate(media: HTMLMediaElement, rate: number): void {
	media.playbackRate = rate
}

function setElementVolume(media: HTMLMediaElement, state: MediaVolume): void {
	media.volume = state.volume
	media.muted = state.muted
}

export function seekMedia(media: HTMLMediaElement, seconds: number): void {
	const duration = mediaDuration(media)

	media.currentTime = Math.max(0, duration > 0 ? Math.min(duration, seconds) : seconds)
}

// Keeps a media element on the shared volume, and adopts a change made on the element itself.
export function useSyncedMediaVolume(media: HTMLMediaElement | null): void {
	useEffect(() => {
		if (media === null) {
			return
		}

		const element = media

		void warmMediaVolume()

		function apply(state: MediaVolume): void {
			setElementVolume(element, state)
		}

		function adopt(): void {
			adoptMediaVolume(element.volume, element.muted)
		}

		apply(useMediaVolumeStore.getState())
		element.addEventListener("volumechange", adopt)

		const unsubscribe = useMediaVolumeStore.subscribe(apply)

		return () => {
			unsubscribe()
			element.removeEventListener("volumechange", adopt)
		}
	}, [media])
}
