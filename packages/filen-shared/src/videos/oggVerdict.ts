import { decidePlayback, type LadderProbe, type PlaybackCapabilities } from "./playbackLadder"
import type { OggVideoFacts } from "./probeOgg"

// Whether an Ogg file whose head holds a real picture stream (oggHeadVideo) is a video in this browser: only
// where the ladder finds a rung for that stream. Asked on the page with this browser's capabilities, never
// stored, since another browser answers otherwise; elsewhere the file stays audio.

// The ladder's view of the picture stream alone, which is what the capability queries are asked for.
export function oggVideoProbe(facts: OggVideoFacts): LadderProbe {
	return {
		container: "ogg",
		video: { codec: facts.codec, codecString: facts.codecString, width: facts.width, height: facts.height },
		audio: []
	}
}

export const OGG_VIDEO_SELECTION = { audioIndex: -1, subtitle: "none" } as const

export function oggVideoVerdict(facts: OggVideoFacts, caps: PlaybackCapabilities): "video" | null {
	return decidePlayback(oggVideoProbe(facts), OGG_VIDEO_SELECTION, caps).path === "unsupported" ? null : "video"
}
