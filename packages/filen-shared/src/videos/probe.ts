import { BlockSource, OutOfFileReadError, ReadBudgetError, type ReadRange } from "./blockSource"
import { MalformedError, UnsupportedContainerError, ascii, readBytes, uint32 } from "./probeBytes"
import { walkIsobmff } from "./probeIsobmff"
import { walkMatroska } from "./probeMatroska"
import { walkMpegTs } from "./probeMpegts"
import { walkOgg } from "./probeOgg"
import { ASF_HEADER, walkAsf } from "./probeAsf"
import { walkAvi } from "./probeAvi"
import { walkFlv } from "./probeFlv"
import { walkMpegPs } from "./probeMpegps"
import { EBML_ID, LEADING_BOXES, TS_SNIFF_BYTES, sniffTransportStream, type TsLayout } from "./transportStreamHead"
import type { ParsedContainer, ParsedTrack, ProbeContainer, ProbeTier, ProbeVideo, VideoProbe } from "./probeTypes"

// The container probe: which tier reads how much, and the record each tier yields.

// Every tier starts at this budget. A card shows badges for files scrolling past, so it never pays for more; a full
// or cover probe is raised by the walk once the header's size is known (an MP4 `moov` read header by header, a
// Matroska SeekHead jump, a hop between attachments).
export const CARD_BLOCK_READS = 4

// Tracks kept per kind, so a file with dozens of subtitle tracks still makes a small record.
const MAX_TRACKS_PER_KIND = 64

export function initialBlockReads(_tier: ProbeTier): number {
	return CARD_BLOCK_READS
}

// The block source one probe of one file reads through, budgeted for its tier.
export function probeSource(size: number, readRange: ReadRange, tier: ProbeTier): BlockSource {
	return new BlockSource(size, readRange, { maxBlockReads: initialBlockReads(tier) })
}

export interface WalkOptions {
	// Also locate what finding the picture track's keyframes takes (an MP4's sample tables, the Matroska
	// Cues), at the cost of the headers that takes; nothing in the probe record changes.
	keyframes?: boolean
}

// The packet layout of an MPEG-TS file, read only when its first bytes could start one.
async function transportStream(source: BlockSource, head: Uint8Array): Promise<TsLayout | null> {
	if (head[0] !== 0x47 && head[4] !== 0x47) {
		return null
	}

	return sniffTransportStream(await readBytes(source, 0, Math.min(TS_SNIFF_BYTES, source.size)), source.size)
}

type SignatureContainer = Extract<ProbeContainer, "ogg" | "avi" | "flv" | "asf" | "ps">

// The containers a fixed signature at the file's start names.
function signatureContainer(head: Uint8Array): SignatureContainer | null {
	if (ascii(head, 0, 4) === "OggS") {
		return "ogg"
	}

	if (ascii(head, 0, 4) === "RIFF" && (ascii(head, 8, 12) === "AVI " || ascii(head, 8, 12) === "AVIX")) {
		return "avi"
	}

	if (ascii(head, 0, 4) === "FLV\x01") {
		return "flv"
	}

	if (ASF_HEADER.every((byte, i) => head[i] === byte)) {
		return "asf"
	}

	return head[0] === 0 && head[1] === 0 && head[2] === 1 && head[3] === 0xba ? "ps" : null
}

const SIGNATURE_WALKERS: Readonly<Record<SignatureContainer, (source: BlockSource, result: ParsedContainer) => Promise<void>>> = {
	ogg: walkOgg,
	avi: walkAvi,
	flv: walkFlv,
	asf: walkAsf,
	ps: walkMpegPs
}

// The container's raw walk, or null when the file is no container this reads. The first bytes decide
// (a transport stream's first packets), so anything else costs one block. A walk that runs out of
// budget or into a malformed structure returns what it found, flagged partial; failed downloads throw.
export async function walkContainer(source: BlockSource, tier: ProbeTier, options: WalkOptions = {}): Promise<ParsedContainer | null> {
	if (source.size < 8) {
		return null
	}

	const head = await readBytes(source, 0, Math.min(16, source.size))
	const matroska = uint32(head, 0) === EBML_ID
	const isobmff = !matroska && LEADING_BOXES.has(ascii(head, 4, 8))
	const other = matroska || isobmff ? null : signatureContainer(head)
	const transport = matroska || isobmff || other !== null ? null : await transportStream(source, head)

	if (!matroska && !isobmff && other === null && transport === null) {
		return null
	}

	const result: ParsedContainer = {
		container: matroska ? "mkv" : (other ?? (transport === null ? "mp4" : "ts")),
		durationSec: null,
		index: null,
		tracks: [],
		tracksFound: false,
		chapters: [],
		cover: null,
		coverLand: null,
		partial: false
	}

	try {
		const keyframes = options.keyframes === true

		if (other !== null) {
			await SIGNATURE_WALKERS[other](source, result)
		} else if (transport !== null) {
			await walkMpegTs(source, tier, result, transport)
		} else {
			await (matroska ? walkMatroska(source, tier, result, keyframes) : walkIsobmff(source, tier, result, keyframes))
		}
	} catch (error) {
		if (error instanceof UnsupportedContainerError) {
			return null
		}

		// A read past the file's end means a size the file cannot hold: malformed, like any other.
		if (!(error instanceof ReadBudgetError || error instanceof MalformedError || error instanceof OutOfFileReadError)) {
			throw error
		}

		result.partial = true
	}

	return result
}

// The picture: the first enabled video track; a disabled one only stands in when nothing else does.
export function pictureTrack(parsed: ParsedContainer): Extract<ParsedTrack, { kind: "video" }> | null {
	let picture: Extract<ParsedTrack, { kind: "video" }> | null = null

	for (const track of parsed.tracks) {
		if (track.kind === "video" && (picture === null || (track.enabled && !picture.enabled))) {
			picture = track
		}
	}

	return picture
}

// The probe record for one tier. A cover probe holds the card's fields too: it walks the same headers.
function toRecord(parsed: ParsedContainer, tier: ProbeTier): VideoProbe {
	const video: ProbeVideo | null = pictureTrack(parsed)?.video ?? null
	const audio: VideoProbe["audio"] = []
	const subs: VideoProbe["subs"] = []

	for (const track of parsed.tracks) {
		if (track.kind === "audio" && audio.length < MAX_TRACKS_PER_KIND) {
			audio.push(track.audio)
		} else if (track.kind === "subtitle" && subs.length < MAX_TRACKS_PER_KIND) {
			subs.push(track.sub)
		}
	}

	return {
		v: 1,
		container: parsed.container,
		durationSec: parsed.durationSec,
		index: parsed.index,
		video,
		audio,
		subs,
		chapters: tier === "full" ? parsed.chapters : [],
		cover: tier === "card" ? null : parsed.cover,
		coverLand: tier === "card" ? null : parsed.coverLand,
		partial: parsed.partial || !parsed.tracksFound
	}
}

// Reads one tier of a file's probe record through `source` (from probeSource). Null for a file that is
// no container this reads (MP4/MOV, Matroska/WebM, MPEG-TS, Ogg, AVI, FLV, ASF, MPEG-PS); throws BlockReadError when a
// download fails.
export async function probeVideo(source: BlockSource, tier: ProbeTier): Promise<VideoProbe | null> {
	const parsed = await walkContainer(source, tier)

	return parsed === null ? null : toRecord(parsed, tier)
}
