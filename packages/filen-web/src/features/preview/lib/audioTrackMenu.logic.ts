import type { VideoProbe } from "@filen/shared/videos"

// Whether the preview's tracks menu lists the probe's audio tracks (else the element's own, or none): it does from two
// on, so a pick's index is then the probe's.
export function menuListsProbeAudio(probe: VideoProbe | null): probe is VideoProbe {
	return probe !== null && probe.audio.length >= 2
}
