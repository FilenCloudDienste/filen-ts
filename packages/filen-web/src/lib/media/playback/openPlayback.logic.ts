import {
	normalizeLadderContainer,
	type LadderBrowser,
	type LadderDecision,
	type LadderSelection,
	type VideoProbe
} from "@filen/shared/videos"
import type { SessionAudio, SessionPath } from "@/lib/media/playback/types"

// Which session plays a ladder decision, as a pure function.

export type SessionPlan =
	| { kind: "direct"; contentType: string; audioIndex: number }
	| { kind: "remux"; path: Exclude<SessionPath, "direct">; audio: SessionAudio | null; idrOnlyStart: boolean }
	| { kind: "none" }

// The Content-Type a direct stream is served with. MOV is probed and served as MP4: Chrome plays it by
// sniffing but answers canPlayType("video/quicktime") with nothing.
function directContentType(container: string): string | null {
	switch (normalizeLadderContainer(container)) {
		case "mp4":
		case "m4v":
		case "mov":
			return "video/mp4"
		case "webm":
			return "video/webm"
		default:
			return null
	}
}

// The remux engine's id for the probe's audio track at `index`: its 1-based place among the file's audio tracks,
// which the probe and the demuxer both list in container order.
export function audioTrackId(index: number): number {
	return index + 1
}

export function sessionPlan(params: {
	decision: LadderDecision
	probe: VideoProbe
	selection: LadderSelection
	browser: LadderBrowser
}): SessionPlan {
	const { decision, probe, selection, browser } = params
	const track = selection.audioIndex >= 0 ? probe.audio[selection.audioIndex] : undefined

	switch (decision.path) {
		case "direct": {
			const contentType = directContentType(probe.container)

			return contentType === null ? { kind: "none" } : { kind: "direct", contentType, audioIndex: selection.audioIndex }
		}
		case "remux":
		case "remux+transcode":
		case "video-only": {
			const mode = decision.audio.mode

			return {
				kind: "remux",
				path: decision.path,
				audio:
					track === undefined || (mode !== "copy" && mode !== "transcode")
						? null
						: { index: selection.audioIndex, trackId: audioTrackId(selection.audioIndex), mode },
				// Firefox's MediaSource starts HEVC only at an IDR picture.
				idrOnlyStart: browser === "firefox" && probe.video?.codec === "hevc"
			}
		}
		case "unsupported":
			return { kind: "none" }
	}
}

// Whether a session on `from` can take `to` in place (an audio switch inside the same pipeline).
export function samePipeline(from: SessionPlan, to: SessionPlan): boolean {
	return from.kind === to.kind && from.kind !== "none"
}
