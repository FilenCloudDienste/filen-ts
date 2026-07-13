import { type } from "arktype"
import { create } from "zustand"
import { useShallow } from "zustand/shallow"
import { kvGetJson, kvSetJson } from "@/lib/storage/adapter"
import { log } from "@/lib/log"
import type { ErrorDTO } from "@/lib/sdk/errors"
import type { AudioPlaybackStatus, LoopMode, QueueTrack } from "@/features/audio/store/audioQueue"
import type { TrackTags } from "@/features/audio/lib/metadata"

// The reactive surface the audio module drives its UI through — the zustand mirror of the engine
// singleton, following useTransfersStore's conventions exactly: an in-memory-only store (the queue is
// deliberately NOT persisted across reloads), pure setters the engine calls imperatively, and
// useShallow selector hooks for React-Compiler-safe stable identities. Only shuffle/loop persist, via
// the kv adapter (the keymap registry's load-once idiom), not zustand middleware.

// Shuffle+loop are the only playback prefs that outlive a reload (mobile parity). Stored under one
// per-tab kv blob (kv is wiped on logout, so no per-account prefix is needed — same as
// keymap.v1.overrides). A malformed value drops the whole blob and both defaults win.
const PREFS_KV_KEY = "audio.v1.prefs"

export const audioPrefsSchema = type({ shuffleEnabled: "boolean", loopMode: "'off'|'all'|'one'" })

interface AudioStore {
	queue: QueueTrack[]
	currentIndex: number
	status: AudioPlaybackStatus
	positionMs: number
	durationMs: number
	shuffleEnabled: boolean
	loopMode: LoopMode
	shuffleOrder: number[]
	// Output-device settings the engine owns; mirrored here purely so the player bar's volume slider /
	// mute toggle render and update reactively (the engine stays the source of truth — it writes these
	// on every setVolume/setMuted and after hydrating the persisted prefs). Not persisted through the
	// store; the engine persists them via its own kv blob.
	volume: number
	muted: boolean
	// LABEL-FIRST error surface: the last playback failure as a structured DTO (errorLabel(dto) renders
	// it). Cleared on the next successful play. Never a spinner-forever state — a failure that exhausts
	// the auto-skip budget settles the status AND leaves this set.
	lastError: ErrorDTO | null
	// Resolved tag reads, keyed by track uuid — populated by the engine as metadata extraction resolves
	// for the current + one-ahead prefetched track (never a bulk scan). A present-but-empty entry
	// (EMPTY_TRACK_TAGS) still means "attempted this session", so the engine never re-parses a tag-less
	// file every time it's revisited.
	tagsByUuid: Record<string, TrackTags>
	// Cover-art blob URLs, keyed by track uuid — a live mirror of the engine's CoverArtCache (the LRU
	// itself lives in the engine; this is purely the reactive read side for the bar/panel). A missing key
	// means "no cached cover", never triggers a fetch on read.
	coverUrlsByUuid: Record<string, string>

	// Whole-queue replacement (folder-open / playlist-play). Resets position/duration/error.
	loadQueue: (queue: QueueTrack[], currentIndex: number, shuffleOrder: number[]) => void
	// Move to another already-queued track (next/previous/skip). Resets position/duration.
	setCurrent: (currentIndex: number, shuffleOrder: number[]) => void
	// In-place queue edit (a now-playing-panel remove) that must NOT disturb playback — sets the queue,
	// current index and shuffle order while leaving position/duration/status/error exactly as they are,
	// unlike loadQueue/setCurrent which reset them.
	setQueueState: (queue: QueueTrack[], currentIndex: number, shuffleOrder: number[]) => void
	// Mirrors the engine's output prefs into the store for the bar's reactive controls.
	setOutput: (volume: number, muted: boolean) => void
	setStatus: (status: AudioPlaybackStatus) => void
	setPosition: (positionMs: number) => void
	setDuration: (durationMs: number) => void
	setError: (lastError: ErrorDTO | null) => void
	// Persists (fire-and-forget). The engine passes the freshly rebuilt shuffle order alongside.
	setShuffle: (shuffleEnabled: boolean, shuffleOrder: number[]) => void
	// Persists (fire-and-forget).
	setLoop: (loopMode: LoopMode) => void
	// Merges one track's resolved tags in. Called once per track per session (memoized by the engine on
	// this map's own presence).
	setTrackTags: (uuid: string, tags: TrackTags) => void
	// Replaces the whole cover-url mirror with the engine's CoverArtCache's current snapshot.
	setCoverUrls: (coverUrlsByUuid: Record<string, string>) => void
	// Engine dispose (logout): clears queue+playback but preserves the persisted shuffle/loop prefs.
	reset: () => void
	// Engine dispose (logout) only: clears the tag/cover mirrors. NOT called by a plain clearQueue — the
	// engine's cover cache (and these mirrors) intentionally survive a manual queue clear.
	resetMetadata: () => void
}

export const useAudioStore = create<AudioStore>(set => ({
	queue: [],
	currentIndex: 0,
	status: "idle",
	positionMs: 0,
	durationMs: 0,
	shuffleEnabled: false,
	loopMode: "off",
	shuffleOrder: [],
	volume: 1,
	muted: false,
	lastError: null,
	tagsByUuid: {},
	coverUrlsByUuid: {},
	loadQueue: (queue, currentIndex, shuffleOrder) => {
		set({ queue, currentIndex, shuffleOrder, positionMs: 0, durationMs: 0, lastError: null })
	},
	setCurrent: (currentIndex, shuffleOrder) => {
		set({ currentIndex, shuffleOrder, positionMs: 0, durationMs: 0 })
	},
	setQueueState: (queue, currentIndex, shuffleOrder) => {
		set({ queue, currentIndex, shuffleOrder })
	},
	setOutput: (volume, muted) => {
		set({ volume, muted })
	},
	setStatus: status => {
		set({ status })
	},
	setPosition: positionMs => {
		set({ positionMs })
	},
	setDuration: durationMs => {
		set({ durationMs })
	},
	setError: lastError => {
		set({ lastError })
	},
	setShuffle: (shuffleEnabled, shuffleOrder) => {
		markPrefsUserModified()
		set({ shuffleEnabled, shuffleOrder })
		void persistPrefs()
	},
	setLoop: loopMode => {
		markPrefsUserModified()
		set({ loopMode })
		void persistPrefs()
	},
	setTrackTags: (uuid, tags) => {
		set(state => ({ tagsByUuid: { ...state.tagsByUuid, [uuid]: tags } }))
	},
	setCoverUrls: coverUrlsByUuid => {
		set({ coverUrlsByUuid })
	},
	reset: () => {
		set({ queue: [], currentIndex: 0, status: "idle", positionMs: 0, durationMs: 0, shuffleOrder: [], lastError: null })
	},
	resetMetadata: () => {
		set({ tagsByUuid: {}, coverUrlsByUuid: {} })
	}
}))

// A user toggle that lands before the persisted-prefs load resolves must win — the late load must never
// stomp it. This flag records that a real user choice was made; hydrateAudioPrefs then skips applying
// the stored value. Mirrors setUserCombo's "await the load first" intent in the keymap registry, kept
// as a flag here since the whole-blob prefs can't be merged key-by-key.
let prefsUserModified = false

function markPrefsUserModified(): void {
	prefsUserModified = true
}

let prefsLoad: Promise<void> | null = null

// Load-once persisted shuffle/loop into the store, memoized like the keymap registry's override load. A
// rejected read is swallowed: a storage hiccup must never break playback, defaults just keep working.
export function hydrateAudioPrefs(): Promise<void> {
	prefsLoad ??= kvGetJson(PREFS_KV_KEY, audioPrefsSchema)
		.then(loaded => {
			if (loaded !== null && !prefsUserModified) {
				useAudioStore.setState({ shuffleEnabled: loaded.shuffleEnabled, loopMode: loaded.loopMode })
			}
		})
		.catch((error: unknown) => {
			log.warn("audio", "failed to load persisted audio prefs", error)
		})

	return prefsLoad
}

async function persistPrefs(): Promise<void> {
	try {
		const { shuffleEnabled, loopMode } = useAudioStore.getState()

		await kvSetJson(PREFS_KV_KEY, { shuffleEnabled, loopMode })
	} catch (error) {
		log.warn("audio", "failed to persist audio prefs", error)
	}
}

// Now-playing selector for the mini-player / now-playing bar — a stable-identity slice of the transport
// state plus the resolved current track's display fields. `title` falls back to the filename until tags
// resolve (or forever, for a tag-less file); `artist`/`album`/`coverUrl` stay null until then. useShallow
// keeps the returned object's identity stable across store updates that don't touch these fields (same
// rationale as useTransfersAggregate).
export function useAudioNowPlaying(): {
	status: AudioPlaybackStatus
	positionMs: number
	durationMs: number
	track: QueueTrack | null
	title: string
	artist: string | null
	album: string | null
	coverUrl: string | null
} {
	return useAudioStore(
		useShallow(state => {
			const track = state.queue[state.currentIndex] ?? null
			const tags = track ? state.tagsByUuid[track.uuid] : undefined

			return {
				status: state.status,
				positionMs: state.positionMs,
				durationMs: state.durationMs,
				track,
				title: tags?.title ?? track?.name ?? "",
				artist: tags?.artist ?? null,
				album: tags?.album ?? null,
				coverUrl: track ? (state.coverUrlsByUuid[track.uuid] ?? null) : null
			}
		})
	)
}

// The shuffle/loop toggle state plus whether anything is queued — for the transport controls.
export function useAudioQueueControls(): { shuffleEnabled: boolean; loopMode: LoopMode; hasQueue: boolean } {
	return useAudioStore(
		useShallow(state => ({
			shuffleEnabled: state.shuffleEnabled,
			loopMode: state.loopMode,
			hasQueue: state.queue.length > 0
		}))
	)
}

// The full queue + current index + cover-url mirror for the now-playing panel's track list. The queue
// array's identity is stable across playback-only updates (position/status writes never touch it), so
// this re-renders the panel only on real queue edits, track changes, or a newly-cached cover.
export function useAudioQueue(): { queue: QueueTrack[]; currentIndex: number; coverUrlsByUuid: Record<string, string> } {
	return useAudioStore(
		useShallow(state => ({
			queue: state.queue,
			currentIndex: state.currentIndex,
			coverUrlsByUuid: state.coverUrlsByUuid
		}))
	)
}

// Volume + mute for the bar's output controls, mirrored from the engine.
export function useAudioOutput(): { volume: number; muted: boolean } {
	return useAudioStore(
		useShallow(state => ({
			volume: state.volume,
			muted: state.muted
		}))
	)
}

// The last playback failure DTO, for the bar's LABEL-FIRST inline error.
export function useAudioError(): ErrorDTO | null {
	return useAudioStore(state => state.lastError)
}
