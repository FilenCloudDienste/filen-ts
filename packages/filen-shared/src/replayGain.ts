// ReplayGain read straight from a parse result's raw native tags, restated structurally so this package never depends
// on music-metadata. Its own `common.replaygain_*` mapping is not used: it reads "+3.2dB" (no space) and a unitless
// "+3.2" as a linear ratio.

// One tag as a music-metadata `native` group lists it: ID3v2 TXXX frames arrive as `TXXX:<description>`, MP4 freeform
// atoms as `----:com.apple.iTunes:<name>`, Vorbis comments and APEv2 items under their bare name.
export interface NativeTag {
	id: string
	value: unknown
}

export type NativeTags = Record<string, readonly NativeTag[] | undefined>

// Each field null when the file does not carry it (or carries a value out of range).
export interface TrackGain {
	trackDb: number | null
	trackPeak: number | null
	albumDb: number | null
	albumPeak: number | null
}

export const NO_TRACK_GAIN: TrackGain = { trackDb: null, trackPeak: null, albumDb: null, albumPeak: null }

// The gain a track without any ReplayGain tag plays at while loudness matching is on: mastered music usually sits
// 6-10 dB above the ReplayGain reference, so an untagged track would otherwise jump out between tagged ones.
export const UNTAGGED_GAIN_DB = -6

const GAIN_LIMIT_DB = 30
const PEAK_LIMIT = 10
const APPLIED_MIN_DB = -24
const APPLIED_MAX_DB = 12

// Opus R128 gains are Q7.8 relative to -23 LUFS; ReplayGain's reference is 5 dB louder.
const R128_TO_REPLAYGAIN_DB = 5

// "+3.2 dB", "+3.2dB", "-7.1", a Unicode minus: a number with an optional trailing dB in any case.
const GAIN_PATTERN = /^([+\-−]?\d+(?:\.\d+)?|[+\-−]?\.\d+)\s*(?:db)?$/i

function text(value: unknown): string | null {
	if (typeof value === "string") {
		return value.replaceAll("\u0000", "").trim()
	}

	if (Array.isArray(value) && typeof value[0] === "string") {
		return text(value[0])
	}

	return null
}

function parseNumber(raw: string): number | null {
	const match = GAIN_PATTERN.exec(raw)

	if (match?.[1] === undefined) {
		return null
	}

	const value = Number.parseFloat(match[1].replace("−", "-"))

	return Number.isFinite(value) ? value : null
}

export function parseGainDb(raw: string): number | null {
	const value = parseNumber(raw.trim())

	return value !== null && Math.abs(value) <= GAIN_LIMIT_DB ? value : null
}

export function parsePeak(raw: string): number | null {
	const value = Number.parseFloat(raw.trim())

	return Number.isFinite(value) && value > 0 && value <= PEAK_LIMIT ? value : null
}

function parseR128(raw: string): number | null {
	const q = raw.trim()

	if (!/^[+-]?\d+$/.test(q)) {
		return null
	}

	return parseGainDb(String(Number.parseInt(q, 10) / 256 + R128_TO_REPLAYGAIN_DB))
}

// The tag name without its container prefix, upper-cased: "TXXX:replaygain_track_gain" → "REPLAYGAIN_TRACK_GAIN".
function bareName(id: string): string {
	const colon = id.lastIndexOf(":")

	return (colon === -1 ? id : id.slice(colon + 1)).toUpperCase()
}

// The first value of each field wins, whichever tag group carries it; an R128 gain counts only where no ReplayGain
// gain is present.
export function parseReplayGain(native: NativeTags | null | undefined): TrackGain {
	const gain: TrackGain = { ...NO_TRACK_GAIN }
	let r128Track: number | null = null
	let r128Album: number | null = null

	if (native === null || native === undefined) {
		return gain
	}

	for (const tags of Object.values(native)) {
		for (const tag of tags ?? []) {
			const raw = text(tag.value)

			if (raw === null || raw.length === 0) {
				continue
			}

			switch (bareName(tag.id)) {
				case "REPLAYGAIN_TRACK_GAIN":
					gain.trackDb ??= parseGainDb(raw)
					break
				case "REPLAYGAIN_TRACK_PEAK":
					gain.trackPeak ??= parsePeak(raw)
					break
				case "REPLAYGAIN_ALBUM_GAIN":
					gain.albumDb ??= parseGainDb(raw)
					break
				case "REPLAYGAIN_ALBUM_PEAK":
					gain.albumPeak ??= parsePeak(raw)
					break
				case "R128_TRACK_GAIN":
					r128Track ??= parseR128(raw)
					break
				case "R128_ALBUM_GAIN":
					r128Album ??= parseR128(raw)
					break
			}
		}
	}

	gain.trackDb ??= r128Track
	gain.albumDb ??= r128Album

	return gain
}

// The linear trim a track plays at. `album` prefers the album gain (a run of consecutive tracks from one album keeps
// its intended dynamics), falling back to the other gain, then to the untagged level. Never boosts past the known peak,
// never boosts at all without one.
export function linearGainFor(gain: TrackGain | null | undefined, options: { album: boolean }): number {
	const g = gain ?? NO_TRACK_GAIN
	const primary = options.album ? { db: g.albumDb, peak: g.albumPeak } : { db: g.trackDb, peak: g.trackPeak }
	const secondary = options.album ? { db: g.trackDb, peak: g.trackPeak } : { db: g.albumDb, peak: g.albumPeak }
	const chosen = primary.db !== null ? primary : secondary.db !== null ? secondary : { db: UNTAGGED_GAIN_DB, peak: null }
	const db = Math.min(APPLIED_MAX_DB, Math.max(APPLIED_MIN_DB, chosen.db ?? UNTAGGED_GAIN_DB))
	const linear = 10 ** (db / 20)
	const peak = chosen.peak ?? primary.peak ?? secondary.peak

	return peak !== null ? Math.min(linear, 1 / peak) : Math.min(linear, 1)
}
