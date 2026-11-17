import { useEffect, useState } from "react"
import { decidePlayback, type VideoProbe } from "@filen/shared/videos"
import { playbackCapabilities } from "@/lib/media/playback/capabilities"
import { streamFacts, toLadderProbe } from "@/lib/media/playback/capabilities.logic"

// Which audio tracks this browser plays only re-encoded, asked while `open` (a tracks menu is showing). Decoder
// answers are kept per session, so asking again costs nothing after the first time.
export function useTranscodedTracks(probe: VideoProbe | null, size: number, open: boolean): ReadonlySet<number> {
	const [transcoded, setTranscoded] = useState<ReadonlySet<number>>(new Set())

	useEffect(() => {
		if (!open || probe === null || probe.audio.length === 0) {
			return
		}

		let live = true
		const ladderProbe = toLadderProbe(probe)

		void Promise.all(
			probe.audio.map(async (_, index) => {
				const selection = { audioIndex: index, subtitle: "none" as const }
				const caps = await playbackCapabilities.capabilities(ladderProbe, selection, streamFacts({ probe, selection, size }))

				return decidePlayback(ladderProbe, selection, caps).audio.mode === "transcode" ? index : -1
			})
		).then(
			results => {
				if (live) {
					setTranscoded(new Set(results.filter(index => index >= 0)))
				}
			},
			() => undefined
		)

		return () => {
			live = false
		}
	}, [probe, size, open])

	return transcoded
}
