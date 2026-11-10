import { MEDIA_JUMP_ACTIONS, type MediaAction } from "@/lib/media/keymap"
import { jumpFraction, MEDIA_LONG_SEEK_STEP_SECONDS, MEDIA_SEEK_STEP_SECONDS, MEDIA_VOLUME_STEP } from "@/lib/media/mediaKeys.logic"
import { stepMediaVolume, toggleMediaMuted } from "@/lib/media/mediaVolume"

// The media keys the audio player bar takes while focus is inside it: what the engine can do with one track.
export const AUDIO_BAR_MEDIA_ACTIONS: readonly MediaAction[] = [
	"media.playPause",
	"media.seekBack",
	"media.seekForward",
	"media.seekBackLong",
	"media.seekForwardLong",
	"media.toStart",
	"media.toEnd",
	...MEDIA_JUMP_ACTIONS,
	"media.volumeUp",
	"media.volumeDown",
	"media.mute",
	"media.previous",
	"media.next"
]

// The engine as the keys drive it: a structural subset, so a test can pass a plain fake.
export interface AudioKeyTransport {
	toggle: () => void
	seek: (seconds: number) => void
	skipNext: () => Promise<void>
	skipPrevious: () => Promise<void>
}

// Where the playhead is and how long the track runs, in seconds (0 until known).
export interface AudioKeyPosition {
	position: number
	duration: number
}

// A seek inside the track: never before its start, never past its end once the end is known.
export function audioSeekTarget(seconds: number, duration: number): number {
	return Math.max(0, duration > 0 ? Math.min(duration, seconds) : seconds)
}

export function runAudioMediaAction(action: MediaAction, engine: AudioKeyTransport, { position, duration }: AudioKeyPosition): void {
	const fraction = jumpFraction(action)

	if (fraction !== null) {
		if (duration > 0) {
			engine.seek(duration * fraction)
		}

		return
	}

	switch (action) {
		case "media.playPause":
			engine.toggle()
			break
		case "media.seekBack":
			engine.seek(audioSeekTarget(position - MEDIA_SEEK_STEP_SECONDS, duration))
			break
		case "media.seekForward":
			engine.seek(audioSeekTarget(position + MEDIA_SEEK_STEP_SECONDS, duration))
			break
		case "media.seekBackLong":
			engine.seek(audioSeekTarget(position - MEDIA_LONG_SEEK_STEP_SECONDS, duration))
			break
		case "media.seekForwardLong":
			engine.seek(audioSeekTarget(position + MEDIA_LONG_SEEK_STEP_SECONDS, duration))
			break
		case "media.toStart":
			engine.seek(0)
			break
		case "media.toEnd":
			if (duration > 0) {
				engine.seek(duration)
			}

			break
		case "media.volumeUp":
			stepMediaVolume(MEDIA_VOLUME_STEP)
			break
		case "media.volumeDown":
			stepMediaVolume(-MEDIA_VOLUME_STEP)
			break
		case "media.mute":
			toggleMediaMuted()
			break
		case "media.previous":
			void engine.skipPrevious()
			break
		case "media.next":
			void engine.skipNext()
			break
		default:
			break
	}
}
