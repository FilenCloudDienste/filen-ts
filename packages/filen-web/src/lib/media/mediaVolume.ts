import { type } from "arktype"
import { create } from "zustand"
import { kvPreference } from "@/lib/storage/preference"
import { log } from "@/lib/log"

// The one output volume every player shares: the video preview, the audio preview and the playlist player
// all read and write this store, so a change in one is the level the next starts at, reloads included.

export interface MediaVolume {
	volume: number
	muted: boolean
}

const MEDIA_VOLUME_KEY = "media.volume.v1"

const DEFAULT_MEDIA_VOLUME: MediaVolume = { volume: 1, muted: false }

// A slider drag or a held arrow key fires many changes; only where it settles is written.
const MEDIA_VOLUME_WRITE_DELAY_MS = 300

function clampVolume(volume: number): number {
	if (!Number.isFinite(volume)) {
		return DEFAULT_MEDIA_VOLUME.volume
	}

	return Math.max(0, Math.min(1, volume))
}

function normalizeMediaVolume(value: MediaVolume): MediaVolume {
	return { volume: clampVolume(value.volume), muted: value.muted }
}

// Raising the volume while muted unmutes: the slider shows 0 while muted, so it would otherwise snap back
// on every move with nothing becoming audible. Moving it to 0 keeps a mute.
function withVolume(current: MediaVolume, volume: number): MediaVolume {
	const clamped = clampVolume(volume)

	return { volume: clamped, muted: current.muted && clamped === 0 }
}

function sameVolume(a: MediaVolume, b: MediaVolume): boolean {
	return a.volume === b.volume && a.muted === b.muted
}

const mediaVolumePreference = kvPreference({
	key: MEDIA_VOLUME_KEY,
	schema: type({ volume: "number", muted: "boolean" }),
	fallback: DEFAULT_MEDIA_VOLUME,
	normalize: normalizeMediaVolume
})

export const useMediaVolumeStore = create<MediaVolume>(() => DEFAULT_MEDIA_VOLUME)

let warm: Promise<void> | null = null
// A change the user made before the stored value arrived wins over it.
let userChanged = false
// What kv holds as far as this tab knows; null until read or written.
let persisted: MediaVolume | null = null
let writeTimer: ReturnType<typeof setTimeout> | null = null

// Loads the stored volume once per tab; every later call returns the same promise. Never rejects.
export function warmMediaVolume(): Promise<void> {
	warm ??= mediaVolumePreference.get().then(
		stored => {
			// A write that landed first is newer than what this read returned.
			persisted ??= stored

			if (!userChanged) {
				useMediaVolumeStore.setState(stored)
			}
		},
		(error: unknown) => {
			log.warn("media", "failed to load the media volume", error)
		}
	)

	return warm
}

async function persistMediaVolume(): Promise<void> {
	const current = normalizeMediaVolume(useMediaVolumeStore.getState())

	if (persisted !== null && sameVolume(persisted, current)) {
		return
	}

	persisted = current

	try {
		await mediaVolumePreference.set(current)
	} catch (error) {
		persisted = null
		log.warn("media", "failed to persist the media volume", error)
	}
}

function applyMediaVolume(next: MediaVolume): void {
	if (sameVolume(useMediaVolumeStore.getState(), next)) {
		return
	}

	userChanged = true
	useMediaVolumeStore.setState(next)

	if (writeTimer !== null) {
		clearTimeout(writeTimer)
	}

	writeTimer = setTimeout(() => {
		writeTimer = null
		void persistMediaVolume()
	}, MEDIA_VOLUME_WRITE_DELAY_MS)
}

export function setMediaVolume(volume: number): void {
	applyMediaVolume(withVolume(useMediaVolumeStore.getState(), volume))
}

export function toggleMediaMuted(): void {
	const { volume, muted } = useMediaVolumeStore.getState()

	applyMediaVolume({ volume, muted: !muted })
}

// A level set on an element itself (a picture-in-picture window's own mute button), taken as given.
export function adoptMediaVolume(volume: number, muted: boolean): void {
	applyMediaVolume({ volume: clampVolume(volume), muted })
}

// Nudges the volume by `delta`. Up from a mute unmutes at the level it left; down stays muted.
export function stepMediaVolume(delta: number): void {
	const { volume, muted } = useMediaVolumeStore.getState()

	if (muted && delta < 0) {
		return
	}

	applyMediaVolume({ volume: clampVolume(volume + delta), muted: false })
}
