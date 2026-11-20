import {
	CueBuilder,
	MAX_SUBTITLE_CUES,
	normalizeLadderContainer,
	type CueStore,
	type ProbeSubtitle,
	type VideoProbe
} from "@filen/shared/videos"
import type { RemuxTextCue } from "@/lib/media/remuxTypes"
import { MAX_EMBEDDED_CUE_CHARS, embeddedCueCharge, isTapTextCodec } from "@/workers/remux/textTap"
import { isMp4TextCodec } from "@/workers/remux/mp4TextTap"
import { fnv1a } from "@/lib/fnv1a"

// Image subtitle formats (PGS, VobSub, DVB), which no tap turns into text.
const IMAGE_SUBTITLE_CODECS = /PGS|VOBSUB|DVB|HDMV|S_IMAGE|^mp4s$/i

// What playback makes of a subtitle track inside the file: "text" when the remux reads its cues (text in Matroska,
// text in an MP4 that is not fragmented, whose moofs are not read), "image" for a bitmap format, and "unsupported"
// for any other (TTML, closed captions, a fragmented MP4's text, a container without a tap).
export type EmbeddedSubtitleSupport = "text" | "image" | "unsupported"

export function embeddedSubtitleSupport(probe: VideoProbe, sub: ProbeSubtitle): EmbeddedSubtitleSupport {
	if (IMAGE_SUBTITLE_CODECS.test(sub.codecId)) {
		return "image"
	}

	switch (normalizeLadderContainer(probe.container)) {
		case "mkv":
		case "webm":
			return isTapTextCodec(sub.codecId) ? "text" : "unsupported"
		case "mp4":
		case "mov":
			return probe.index !== "mfra" && probe.index !== "none" && isMp4TextCodec(sub.codecId) ? "text" : "unsupported"
		default:
			return "unsupported"
	}
}

// Identifies an embedded cue: two blocks of a track may start together (two speakers, a sign and dialogue).
function embeddedCueIdentity(cue: RemuxTextCue): string {
	return `${String(cue.track)}:${String(Math.round(cue.start * 1000))}:${String(Math.round(cue.end * 1000))}:${String(cue.text.length)}:${fnv1a(cue.text).toString(36)}`
}

interface EmbeddedTrack {
	cues: RemuxTextCue[]
	// Bumped per cue added; the store is rebuilt when it lags.
	version: number
	store: { version: number; store: CueStore } | null
}

// The embedded text cues of one open file, as the remux reads them. A restarted remux (a demotion, an audio
// change, a seek) reads the same blocks again, so each cue is kept once, up to what a cue store holds per track
// and the character budget the remux tap keeps over all of them: the bytes are the file's, which may be anyone's.
// A track's store is rebuilt only when that track got cues.
export class EmbeddedCues {
	private tracks = new Map<number, EmbeddedTrack>()
	private keys = new Set<string>()
	private chars = 0

	// Keeps the cues of the tracks `offered` accepts; returns the tracks that got any.
	public add(cues: readonly RemuxTextCue[], offered: (track: number) => boolean): Set<number> {
		const grown = new Set<number>()

		for (const cue of cues) {
			if (!offered(cue.track)) {
				continue
			}

			const key = embeddedCueIdentity(cue)

			if (this.keys.has(key)) {
				continue
			}

			const charge = embeddedCueCharge(cue.text)

			if (this.chars + charge > MAX_EMBEDDED_CUE_CHARS) {
				break
			}

			let entry = this.tracks.get(cue.track)

			if (entry === undefined) {
				entry = { cues: [], version: 0, store: null }
				this.tracks.set(cue.track, entry)
			}

			if (entry.cues.length >= MAX_SUBTITLE_CUES) {
				continue
			}

			this.keys.add(key)
			this.chars += charge
			entry.cues.push(cue)
			entry.version += 1
			grown.add(cue.track)
		}

		return grown
	}

	// Whether `track` holds cues its last built store lacks.
	public stale(track: number): boolean {
		const entry = this.tracks.get(track)

		return entry !== undefined && entry.store?.version !== entry.version
	}

	// The cues of `track` read so far; null before any.
	public store(track: number): CueStore | null {
		const entry = this.tracks.get(track)

		if (entry === undefined || entry.cues.length === 0) {
			return null
		}

		if (entry.store?.version === entry.version) {
			return entry.store.store
		}

		const builder = new CueBuilder()

		for (const cue of entry.cues) {
			builder.add(cue.start, cue.end, cue.text, cue.hint)
		}

		const store = builder.finish()

		entry.store = { version: entry.version, store }

		return store
	}

	public clear(): void {
		this.tracks = new Map()
		this.keys = new Set()
		this.chars = 0
	}
}
