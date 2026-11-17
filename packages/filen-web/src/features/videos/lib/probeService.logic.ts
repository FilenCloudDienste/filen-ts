import { type } from "arktype"
import { extensionStart } from "@filen/shared"
import {
	MEDIA_CODECS,
	PROBE_CONTAINERS,
	PROBE_INDEXES,
	VIDEO_CONTAINERS,
	type ProbeContainer,
	type ProbeTier,
	type VideoProbe
} from "@filen/shared/videos"

// The probe scheduler's rules and the persisted probe record. Plain and DOM-free.

// Where a probe request queues, lowest first: what the user acted on (play, a detail page), a card that
// stayed visible, a card near the viewport once scrolling stopped, then idle prefetch.
export const PROBE_RANK = {
	explicit: 0,
	visible: 1,
	nearViewport: 2,
	idle: 3
} as const

// How long a card stays visible before it asks for its probe.
export const CARD_PROBE_DWELL_MS = 400

export const PROBE_CONCURRENCY = 2

// A probe nobody wants any more keeps running this long, for a card scrolled straight back.
export const PROBE_DROP_GRACE_MS = 300

// An unwanted probe this many blocks from the end of its current read budget finishes (its record is
// persisted); any further from it, it is cancelled.
export const PROBE_FINISH_WITHIN_BLOCKS = 1

// The third failed download for a file ends its probing for the session, until the connection returns.
export const PROBE_FAILURE_LIMIT = 3

// Probes started per session before only explicit requests may start more.
export const PROBE_SESSION_SOFT_CAP = 200

export const PROBE_KV_PREFIX = "videos.v1.probe."
export const PROBE_MAX_RECORDS = 20_000

const probeVideoSchema = type({
	codec: type.enumerated(...MEDIA_CODECS).or("null"),
	fourcc: "string",
	codecString: "string | null",
	w: "number",
	h: "number",
	par: "number",
	rotation: "number",
	bitDepth: "number | null",
	transfer: "'sdr' | 'pq' | 'hlg'",
	"dv?": { profile: "number", compat: "number" }
})

const coverSchema = type({ offset: "number", size: "number", mime: "string" })

const videoProbeSchema = type({
	v: "1",
	container: type.enumerated(...PROBE_CONTAINERS),
	durationSec: "number | null",
	index: type.enumerated(...PROBE_INDEXES).or("null"),
	video: probeVideoSchema.or("null"),
	audio: type({
		id: "number",
		codec: type.enumerated(...MEDIA_CODECS).or("null"),
		codecString: "string | null",
		ch: "number | null",
		rate: "number | null",
		lang: "string | null",
		name: "string | null",
		def: "boolean",
		forced: "boolean",
		commentary: "boolean"
	}).array(),
	subs: type({
		id: "number",
		codecId: "string",
		lang: "string | null",
		name: "string | null",
		def: "boolean",
		forced: "boolean",
		hi: "boolean"
	}).array(),
	chapters: type({ t: "number", "end?": "number", title: "string | null", "skipType?": "number" }).array(),
	cover: coverSchema.or("null"),
	// Absent from a record written before landscape covers were read.
	"coverLand?": coverSchema.or("null"),
	partial: "boolean"
})

// One file's probe, merged across the tiers read so far, keyed by its uuid (a content change rotates
// it). `probe` null is a file that is no container the probe reads. Playability is never stored: it
// depends on the browser asking, decided at play time.
export const probeRecordSchema = type({
	probe: videoProbeSchema.or("null"),
	tiers: { card: "boolean", full: "boolean", cover: "boolean" },
	at: "number",
	// PROBE_REVISION of the probe that wrote it; absent from the records before it.
	"rev?": "number"
})

export type ProbeRecord = typeof probeRecordSchema.infer

// The probe as it reads now. Revision 2: transport streams, and Matroska's landscape cover. Revision 3: Ogg, AVI, FLV,
// ASF and MPEG program streams, and the 3GPP codecs (H.263, AMR). A record from before keeps answering unless it is one
// this probe would read differently (outdatedRecord).
export const PROBE_REVISION = 3

const TRANSPORT_STREAM_EXTENSIONS: ReadonlySet<string> = new Set(["ts", "mts", "m2ts", "m2t"])

// The probe's containers revision 3 first read.
const REVISION_3_CONTAINERS: ReadonlySet<ProbeContainer> = new Set(["ogg", "avi", "flv", "asf", "ps"])

function extensionOfName(name: string | null): string | null {
	const dot = name === null ? -1 : extensionStart(name)

	return name === null || dot === -1 ? null : name.slice(dot + 1).toLowerCase()
}

// A record a probe now would answer otherwise, by the revision that changed the answer: before 2, no container for a
// transport stream's name, or a Matroska cover read that never looked for the landscape one; before 3, no container
// for a name the new walkers read, or an MP4/QuickTime track whose codec the 3GPP sample entries now name.
function outdatedRecord(record: ProbeRecord, tier: ProbeTier, nameOf: () => string | null): boolean {
	const revision = record.rev ?? 1
	const probe = record.probe

	if (revision >= PROBE_REVISION) {
		return false
	}

	if (probe === null) {
		const extension = extensionOfName(nameOf())

		if (extension === null) {
			return false
		}

		const walker = VIDEO_CONTAINERS.get(extension)?.probe

		return (revision < 2 && TRANSPORT_STREAM_EXTENSIONS.has(extension)) || (walker !== undefined && REVISION_3_CONTAINERS.has(walker))
	}

	if (revision < 2 && tier !== "card" && outdatedCover(record)) {
		return true
	}

	return (
		(probe.container === "mp4" || probe.container === "mov") &&
		(probe.video?.codec === null || probe.audio.some(audio => audio.codec === null))
	)
}

function outdatedCover(record: ProbeRecord): boolean {
	const probe = record.probe

	return record.rev === undefined && probe !== null && probe.container === "mkv" && probe.cover !== null && probe.coverLand === undefined
}

// Whether `record` already answers a request for `tier` of the file `nameOf` names (null where unknown; asked
// only of an old record without a probe): the full tier holds the card's fields and the cover.
export function recordSatisfies(record: ProbeRecord, tier: ProbeTier, nameOf: () => string | null = () => null): boolean {
	if (outdatedRecord(record, tier, nameOf)) {
		return false
	}

	return record.probe === null || record.tiers[tier] || record.tiers.full
}

// `existing` with one tier's result folded in. A full read replaces everything; a cover read holds the
// card's fields too, so it answers both; a card keeps the covers already found. A record without a probe
// read nothing a new one could keep.
export function mergeProbe(existing: ProbeRecord | null, tier: ProbeTier, probe: VideoProbe | null, at: number): ProbeRecord {
	const kept = existing?.probe === null ? null : existing
	const tiers = { card: false, full: false, cover: false, ...kept?.tiers }

	if (probe === null) {
		return { probe: null, tiers: { card: true, full: true, cover: true }, at, rev: PROBE_REVISION }
	}

	if (tier === "full") {
		return { probe, tiers: { card: true, full: true, cover: true }, at, rev: PROBE_REVISION }
	}

	if (tier === "cover") {
		return { probe, tiers: { ...tiers, card: true, cover: true }, at, rev: PROBE_REVISION }
	}

	// Covers read before the landscape one was looked for are read again by the next cover request.
	const coversCurrent = kept === null || !outdatedCover(kept)

	return {
		probe: { ...probe, cover: kept?.probe?.cover ?? null, coverLand: kept?.probe?.coverLand ?? null },
		tiers: { ...tiers, card: true, cover: tiers.cover && coversCurrent, full: tiers.full && coversCurrent },
		at,
		rev: PROBE_REVISION
	}
}

// Whether a request at `rank` may start a probe, with `started` probes already started this session.
export function mayStartProbe(rank: number, started: number): boolean {
	return rank <= PROBE_RANK.explicit || started < PROBE_SESSION_SOFT_CAP
}
