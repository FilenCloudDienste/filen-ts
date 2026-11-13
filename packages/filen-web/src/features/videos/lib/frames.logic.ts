import { type } from "arktype"
import { BLOCK_BYTES, type VideoProbe } from "@filen/shared/videos"

// Generated frames: which files may have one, what a session may spend on them, and the per-file hint
// that makes a regeneration a single read. Plain and DOM-free.

// Bumped when the frame choice changes (positions, luma rule), retiring every hint and negative verdict.
export const FRAME_RECIPE_VERSION = 1

export const FRAME_HINT_KV_PREFIX = "videos.v1.frame."
export const FRAME_HINT_MAX_RECORDS = 20_000

// Block reads one frame may make: the header walk, the index entries, the keyframe itself.
export const FRAME_READS_PER_ITEM = 8
export const FRAME_SESSION_MAX_FRAMES = 40
export const FRAME_SESSION_MAX_BYTES = 64 * 1_048_576

// How long a frame's requester must stay interested before anything is read.
export const FRAME_DWELL_MS = 300

export type FrameMiss = "noIndex" | "unsupported" | "decode" | "budget"

// Where the chosen keyframe sits and how to decode it, so the next generation reads only the keyframe.
// `description` is the decoder's configuration record, base64.
export const frameKeySchema = type({
	offset: "number",
	size: "number",
	timeSec: "number",
	codec: "string",
	codedWidth: "number",
	codedHeight: "number",
	description: "string | null"
})

export type FrameKey = typeof frameKeySchema.infer

// Per video uuid: the keyframe a frame was made from, or why none could be (null `key`).
export const frameHintSchema = type({
	recipe: "number",
	key: frameKeySchema.or("null"),
	miss: "'noIndex' | 'unsupported' | 'decode' | 'budget' | null",
	at: "number"
})

export type FrameHint = typeof frameHintSchema.infer

// A file whose captures failed this many times without a verdict (a failed download, a timeout, a
// decoder error) is left alone for the session.
export const FRAME_FAILURE_LIMIT = 3

// Whether a miss is a lasting verdict about the file: no keyframe index, a codec the browser cannot
// decode, or the full read allowance spent. A decoder error may be passing, and a budget this session
// had cut short says nothing about the file.
export function missIsSettled(reason: FrameMiss, maxReads: number): boolean {
	return reason === "noIndex" || reason === "unsupported" || (reason === "budget" && maxReads >= FRAME_READS_PER_ITEM)
}

// A hint of this recipe that says no frame can be made.
export function isSettledMiss(hint: FrameHint | null): boolean {
	return hint !== null && hint.recipe === FRAME_RECIPE_VERSION && hint.key === null
}

export function usableKey(hint: FrameHint | null): FrameKey | null {
	return hint !== null && hint.recipe === FRAME_RECIPE_VERSION ? hint.key : null
}

// Frames come only from files whose keyframes can be found without scanning: MP4/MOV with sample tables,
// a fragmented MP4 with an mfra, Matroska/WebM with Cues. A card probe of an MP4 may leave the index unknown
// (null); a fragmented MP4 without an mfra ("none") has nothing to find them with.
export function frameEligible(probe: VideoProbe | null): boolean {
	if (probe === null) {
		return false
	}

	if (probe.video === null) {
		return false
	}

	if (probe.container === "mkv" || probe.container === "webm") {
		return probe.index === "cues"
	}

	return probe.index === "moov" || probe.index === "mfra" || probe.index === null
}

// What generated frames may still spend this session.
export class FrameSessionBudget {
	private frames = 0
	private bytes = 0
	private readonly maxFrames: number
	private readonly maxBytes: number

	public constructor(maxFrames = FRAME_SESSION_MAX_FRAMES, maxBytes = FRAME_SESSION_MAX_BYTES) {
		this.maxFrames = maxFrames
		this.maxBytes = maxBytes
	}

	// Block reads the next frame may make; 0 once the session is spent.
	public readsAvailable(): number {
		if (this.frames >= this.maxFrames) {
			return 0
		}

		return Math.max(0, Math.min(FRAME_READS_PER_ITEM, Math.floor((this.maxBytes - this.bytes) / BLOCK_BYTES)))
	}

	// One generation that made `reads` block reads (each at most a block).
	public spend(reads: number): void {
		this.frames++
		this.bytes += reads * BLOCK_BYTES
	}

	public reset(): void {
		this.frames = 0
		this.bytes = 0
	}
}

export function bytesToBase64(bytes: Uint8Array): string {
	let binary = ""

	for (let at = 0; at < bytes.length; at += 0x8000) {
		binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000))
	}

	return btoa(binary)
}

export function base64ToBytes(text: string): Uint8Array {
	const binary = atob(text)
	const bytes = new Uint8Array(binary.length)

	for (let i = 0; i < binary.length; i++) {
		bytes[i] = binary.charCodeAt(i)
	}

	return bytes
}
