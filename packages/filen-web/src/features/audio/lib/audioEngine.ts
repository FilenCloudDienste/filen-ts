import { AudioEngine } from "@/features/audio/lib/engine"
import { createDomAudioAdapter, resolveTrackSource } from "@/features/audio/lib/bytes"
import { hydrateAudioPrefs } from "@/features/audio/store/useAudioStore"

// The app-lifetime audio engine singleton, wired with the real DOM element adapter + SW/blob source
// resolver. One instance owns playback for the whole session — same pattern as sdkApi. Import this from
// UI/handoff code; import the class directly from engine.ts only in tests (with injected fakes).
export const audioEngine = new AudioEngine({
	createElement: createDomAudioAdapter,
	resolveSource: resolveTrackSource
})

// Restore persisted prefs and bind the foreground-reconcile lifecycle once, at first import. All
// best-effort — never blocks or throws into a caller.
void hydrateAudioPrefs()
void audioEngine.hydrateOutputPrefs()
audioEngine.bindLifecycle()

// Logout teardown (wired into performLogout): stop playback, revoke the live blob URL, tear down the
// element, clear the queue. Nothing leaks across sessions.
export function disposeAudioEngine(): void {
	audioEngine.dispose()
}
