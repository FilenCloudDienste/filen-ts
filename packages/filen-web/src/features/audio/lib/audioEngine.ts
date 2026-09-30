import { AudioEngine } from "@/features/audio/lib/engine"
import { createDomAudioAdapter, createDomPrefetchAdapter, resolveTrackSource } from "@/features/audio/lib/bytes"
import { bindMediaSessionActions, createMediaSessionPublisher } from "@/features/audio/lib/mediaSession"
import { trackMetadata } from "@/features/audio/lib/trackMetadata"
import { hydrateAudioPrefs, useAudioStore } from "@/features/audio/store/useAudioStore"
import { warmMediaVolume } from "@/lib/media/mediaVolume"

// The app-lifetime audio engine singleton, wired with the real DOM element adapter + SW/blob source
// resolver + OS Media Session bridge + one-track-ahead prefetch + the track-metadata service's covers. One instance
// owns playback for the whole session — same pattern as sdkApi. Import this from UI/handoff code; import
// the class directly from engine.ts only in tests (with injected fakes). The publisher (engine → OS
// metadata/state) feature-detects internally, so this stays a no-op wherever Media Session is
// unsupported.
export const audioEngine = new AudioEngine({
	createElement: createDomAudioAdapter,
	createPrefetchElement: createDomPrefetchAdapter,
	resolveSource: resolveTrackSource,
	mediaSession: createMediaSessionPublisher(),
	resolveCover: (track, source) => trackMetadata.playbackCover(track, source.kind === "blob" ? source.blob : undefined)
})

// Restore persisted prefs and bind the foreground-reconcile lifecycle once, at first import. All
// best-effort — never blocks or throws into a caller.
void hydrateAudioPrefs()
void warmMediaVolume()
audioEngine.bindLifecycle()

// Wire OS media keys / lock-screen controls back into the engine (OS → engine). Feature-detected inside
// bindMediaSessionActions; the seek-nudge handlers read the live playhead off the store so a relative
// jump lands correctly. Async skip actions are fired-and-forget — the OS handler signature is void.
bindMediaSessionActions(
	{
		resume: () => {
			audioEngine.resume()
		},
		pause: () => {
			audioEngine.pause()
		},
		skipNext: () => {
			void audioEngine.skipNext()
		},
		skipPrevious: () => {
			void audioEngine.skipPrevious()
		},
		seek: seconds => {
			audioEngine.seek(seconds)
		}
	},
	() => useAudioStore.getState().positionMs / 1000
)

// Logout teardown (wired into performLogout): stop playback, revoke the live blob URL, tear down the
// element, clear the queue, and abort every track-metadata read with its cover URLs and tags in memory.
// Nothing leaks across sessions.
export function disposeAudioEngine(): void {
	audioEngine.dispose()
	trackMetadata.reset()
}
