// Per-uuid video playback continuity for the drive preview overlay's pager — mobile keeps 3 warm
// players so paging away and back resumes mid-scene; a web <video> element is remounted fresh on every
// pager step instead (mediaViewer.tsx's MediaElement, keyed by previewOverlay.tsx's own
// previewSourceKey), so no player ever stays "warm" here. This module is the web-appropriate
// equivalent: a small module-level map remembering where playback LEFT OFF, keyed by the item's own
// uuid, applied on the next remount of that same uuid. Module-level (not component state) so it
// survives a full unmount/remount of the video element itself, which is exactly when it needs to act.
//
// Scoped to one overlay SESSION only — previewOverlay.tsx clears this on its own unmount (the overlay
// closing), so a later, unrelated preview session never inherits a stale position for a uuid it
// happens to reopen.
export interface VideoPlaybackState {
	currentTime: number
	wasPlaying: boolean
}

const positions = new Map<string, VideoPlaybackState>()

export function getVideoPlaybackState(uuid: string): VideoPlaybackState | undefined {
	return positions.get(uuid)
}

export function setVideoPlaybackState(uuid: string, state: VideoPlaybackState): void {
	positions.set(uuid, state)
}

export function clearVideoPlaybackStates(): void {
	positions.clear()
}
