import { type } from "arktype"
import { extensionStart } from "@filen/shared"

// One audio file's parsed tags, persisted per file uuid so a track already read costs nothing on any later
// visit. A uuid rotates whenever the file's content changes, so uuid keying is the whole invalidation
// story. `parsed: false` records a file the parser could not read (final for that content); `cover` is
// true only when a cover thumbnail was actually stored in the thumbnail cache. `gain` is absent on a record parsed
// before ReplayGain was read ("not read yet"); a new parse always carries it, all nulls when the file has none.
// `oggVideo`, on an Ogg file's record only: the real picture stream its head holds (oggHeadVideo), null when the read
// found none, absent when the record predates the check.
export const trackGainSchema = type({
	trackDb: "number | null",
	trackPeak: "number | null",
	albumDb: "number | null",
	albumPeak: "number | null"
})

export const oggVideoFactsSchema = type({
	codec: "'theora' | 'vp8'",
	codecString: "string",
	width: "number",
	height: "number"
})

export const trackTagRecordSchema = type({
	title: "string | null",
	artist: "string | null",
	album: "string | null",
	durationSec: "number | null",
	cover: "boolean",
	parsed: "boolean",
	"gain?": trackGainSchema,
	"oggVideo?": oggVideoFactsSchema.or("null"),
	at: "number"
})

export type TrackTagRecord = typeof trackTagRecordSchema.infer

// Cover thumbnails come from the SDK's webp encoder, whichever path produced them.
export const COVER_THUMBNAIL_TYPE = "image/webp"

// Versioned so a parser upgrade that reads more files can retire every stored verdict at once.
export const TRACK_TAGS_KV_PREFIX = "audio.v1.tags."

// A few MB of kv at most; past it the oldest records go (orphans of rotated uuids first, in practice).
export const TRACK_TAGS_MAX_RECORDS = 20_000

export function trackTagsKey(uuid: string): string {
	return `${TRACK_TAGS_KV_PREFIX}${uuid}`
}

// The uuids to drop so at most `max` records remain, oldest `at` first.
export function planTrackTagEvictions(records: [string, TrackTagRecord][], max: number): string[] {
	if (records.length <= max) {
		return []
	}

	return [...records]
		.sort((a, b) => a[1].at - b[1].at)
		.slice(0, records.length - max)
		.map(([uuid]) => uuid)
}

// audio/ogg, video/ogg, and Firefox's application/ogg.
const OGG_TYPE = /^\s*[a-z]+\/ogg\s*(?:;|$)/i
const OGG_EXTENSIONS: ReadonlySet<string> = new Set(["ogg", "oga", "ogv", "opus"])

// An Ogg file by its name's extension or its stored type: the files whose record carries `oggVideo`.
export function isOggTrack(track: { name: string; mime: string }): boolean {
	const dot = extensionStart(track.name)

	return (dot !== -1 && OGG_EXTENSIONS.has(track.name.slice(dot + 1).toLowerCase())) || OGG_TYPE.test(track.mime)
}

export function trackDisplayTitle(tags: { title: string | null } | null | undefined, fileName: string): string {
	return tags?.title ?? fileName
}
