import { recordVideoResume, videoResumeAt, type ResumableFile } from "@/lib/media/videoResume"

// Per-uuid video playback continuity for the drive preview overlay's pager — mobile keeps 3 warm
// players so paging away and back resumes mid-scene; a web <video> element is remounted fresh on every
// pager step instead (videoPlayer.tsx, keyed by the item's uuid), so no player ever stays "warm" here. This module is the web-appropriate
// equivalent: a small module-level map remembering where playback LEFT OFF, keyed by the item's own
// uuid, applied on the next remount of that same uuid. Module-level (not component state) so it
// survives a full unmount/remount of the video element itself, which is exactly when it needs to act.
//
// The map is scoped to one overlay SESSION only — previewOverlay.tsx clears it on its own unmount (the overlay
// closing), so a later, unrelated preview session never inherits a stale position for a uuid it
// happens to reopen. A long video of the user's own (bindVideoResume) is also remembered across sessions, in
// lib/media/videoResume.ts, and a later session starts there.
//
// currentTime only: the viewer always autoplays a fresh mount regardless of how playback last left
// off, so a remembered "was it playing" bit would have nothing to condition on and stayed write-only
// dead state — this module only needs to answer "where", never "whether".
const positions = new Map<string, number>()
// Position keys whose file is remembered across sessions. Kept past the overlay's close: its clear runs before the
// player's own unmount, which records where playback stopped. Rebound on every open, a few fields per video opened.
const resumable = new Map<string, ResumableFile>()

export function getVideoPosition(uuid: string): number | undefined {
	return positions.get(uuid)
}

// `durationSec` decides whether the position is worth keeping past the session; a video that ran to its end is
// recorded at 0, which forgets it.
export function setVideoPosition(uuid: string, seconds: number, durationSec = 0): void {
	positions.set(uuid, seconds)

	const file = resumable.get(uuid)

	if (file !== undefined) {
		recordVideoResume(file, seconds, durationSec, seconds === 0)
	}
}

export function bindVideoResume(key: string, file: ResumableFile): void {
	resumable.set(key, file)
}

// Where a fresh mount starts: where this session left it, else where an earlier session did (`resumed`).
export function videoStartTime(key: string): { seconds: number; resumed: boolean } {
	const session = positions.get(key)

	if (session !== undefined) {
		return { seconds: session, resumed: false }
	}

	const file = resumable.get(key)
	const remembered = file === undefined ? undefined : videoResumeAt(file)

	return remembered === undefined ? { seconds: 0, resumed: false } : { seconds: remembered, resumed: true }
}

export function clearVideoPlaybackStates(): void {
	positions.clear()
}
