// The video editor's shared vocabulary: the edit recipe (what the user did, never frames), what the export
// plan decides from it, and where a save goes. Framework-free; the libs, the export worker, the editor and the
// overlay all speak these.

import type { DriveItem } from "@/features/drive/lib/item"
import type { Adjustments } from "@/features/preview/imageEdit/types"

// Seconds on the SOURCE timeline.
export interface TimeRange {
	start: number
	end: number
}

// Clockwise rotation applied on top of the source's own rotation metadata.
export type VideoRotation = 0 | 90 | 180 | 270

// In DISPLAY space (after the source's rotation metadata), source pixels; even values so 4:2:0 encoders accept it.
export interface VideoCrop {
	x: number
	y: number
	width: number
	height: number
}

export type OutputResolution = "original" | 1080 | 720 | 480

export type OutputQuality = "high" | "medium" | "low"

// The subset of the image editor's adjustments the shared colour-grade shader applies to video.
export type VideoAdjustments = Pick<
	Adjustments,
	"exposure" | "brightness" | "contrast" | "highlights" | "shadows" | "warmth" | "tint" | "saturation" | "vibrance"
>

// Coordinates normalised 0..1 of the OUTPUT frame (after crop/rotate), anchored at the box's centre; size is a
// fraction of the output height. Times are on the OUTPUT timeline (after cuts and speed).
export interface TextOverlay {
	id: string
	text: string
	startSec: number
	endSec: number
	x: number
	y: number
	size: number
	color: string
	background: boolean
}

export interface VideoAudioEdit {
	mute: boolean
	// 0 = unchanged.
	gainDb: number
	// Ordinal audio track numbers (mediabunny `InputAudioTrack.number`) to keep; "first" keeps only the first.
	keepTracks: readonly number[] | "first"
}

export interface VideoEditRecipe {
	// Sorted, non-overlapping, non-empty; the untouched recipe keeps [0, duration].
	keep: readonly TimeRange[]
	crop: VideoCrop | null
	rotate: VideoRotation
	flipH: boolean
	flipV: boolean
	output: { resolution: OutputResolution; quality: OutputQuality }
	audio: VideoAudioEdit
	// 0.25..4; 1 = unchanged. Audio keeps its pitch.
	speed: number
	adjust: VideoAdjustments
	// A FILTER_PRESETS id shared with the image editor, or null.
	filter: string | null
	text: readonly TextOverlay[]
	// false = the fast copy path is allowed where the recipe permits it (cut edges snap to key frames).
	precise: boolean
	removeLocation: boolean
}

export type ExportMode = "copy" | "transcode"

export type HdrHandling = "keep" | "hevc10" | "toSdr"

export type ExportContainer = "mp4" | "mov"

// Where a save goes: a new version of the open file, or a copy beside it.
export type VideoSaveTarget = "inPlace" | "copy"

// What the export will drop, for the Save popover.
export type ExportDrop = "subtitles" | "chapters" | "extraAudio" | "hdrMetadata" | "location"

export interface SnappedEdge {
	requested: number
	actual: number
}

// The pure answer of plan(recipe, probe, capabilities); never touches I/O.
export interface ExportPlan {
	mode: ExportMode
	// Why the plan could not use the copy path (empty when mode is "copy").
	transcodeReasons: readonly string[]
	// Options the recipe asks for that this browser cannot do (disabled in the UI with the reason).
	unavailable: readonly string[]
	// What in this recipe this browser cannot export (plan.ts ExportBlocker ids): a save is refused while any remain.
	blockers: readonly string[]
	// Muting the audio would clear every blocker (an audio codec, gain or speed this browser cannot re-encode).
	mutingUnblocks: boolean
	dropped: readonly ExportDrop[]
	hdr: HdrHandling | null
	container: ExportContainer
	targets: readonly VideoSaveTarget[]
	estimateBytes: number
	estimateSeconds: number
	// Kept-range edges the copy path moved to a key frame.
	snapped: readonly SnappedEdge[]
	outputDuration: number
}

export type TransferCharacteristic = "sdr" | "pq" | "hlg"

export interface VideoSourceAudioTrack {
	// mediabunny `InputAudioTrack.number` (1-based among audio tracks).
	number: number
	codec: string | null
	channels: number
	language: string | null
}

// What the editor learns about the original before editing; read once per open from the probe and the input.
export interface VideoSourceInfo {
	duration: number
	// Display size (after the pixel aspect ratio and the rotation metadata), square pixels.
	width: number
	height: number
	// The coded frame's size (before both): differs from the unrotated display size for anamorphic sources.
	codedWidth: number
	codedHeight: number
	// The source's own rotation metadata.
	rotation: VideoRotation
	// Average frames per second (VFR sources: a hint only; frame stepping uses real timestamps).
	frameRate: number
	videoCodec: string | null
	transfer: TransferCharacteristic
	bitDepth: number
	// Key frame presentation times, ascending; the copy path snaps to these.
	keyframes: Float64Array
	audio: readonly VideoSourceAudioTrack[]
	container: string
	hasSubtitles: boolean
	hasChapters: boolean
	hasLocation: boolean
	bytes: number
	// Whether this browser can decode the video for preview (no preview ⇒ no Edit).
	previewable: boolean
}

export interface ExportProgress {
	// 0..1
	fraction: number
	bytesWritten: number
	etaSeconds: number | null
}

// What went wrong in a save that failed, for the editor to word (the raw cause is only logged): the export made no
// progress for too long; its worker died or stopped answering; the upload failed; anything else.
export type VideoSaveErrorCode = "stalled" | "workerLost" | "uploadFailed" | "unknown"

// "done": `item` is what the save made (the new version, or the copy).
export type ExportOutcome = { status: "done"; item: DriveItem } | { status: "cancelled" } | { status: "error"; code: VideoSaveErrorCode }

// Why a save never started (or stopped for its input rather than a fault; retrying will not help): offline; the
// account's storage cannot hold the estimate; the recipe asks for what this browser cannot do; a copy fragment would
// exceed iOS's memory cap; no video to export; a codec the export cannot copy or decode; a target the plan does not
// offer for this file; a new version of this file is being saved already (one at a time per file).
export type VideoSaveRefusal = "offline" | "quota" | "unavailable" | "gop" | "noVideo" | "codec" | "target" | "busy"

// How a save of an export ended, as the editor reports it: ExportOutcome, a refusal, or the file changed elsewhere
// before the upload started (`currentUuid`: its version now, null when it is gone), for the remote-change dialog.
// "error" is a fault worth a retry (the recipe is kept): a failed upload, a stalled or lost worker.
export type VideoSaveOutcome =
	ExportOutcome | { status: "refused"; reason: VideoSaveRefusal } | { status: "remoteChanged"; currentUuid: string | null }

// The worker-side surface the editor UI drives (implemented in videoEdit/client.ts).
export interface VideoEditClient {
	loadSource(): Promise<VideoSourceInfo>
	// Exact frame at `time` (nearest real sample at or before it), scaled to fit `maxWidth`, with the recipe's
	// geometry + colour applied by the same GPU pass the export uses. The caller owns and closes the bitmap.
	frameAt(time: number, recipe: VideoEditRecipe, maxWidth: number): Promise<ImageBitmap>
	// Filmstrip thumbnails at the given source times (budgeted; may return fewer).
	filmstrip(times: readonly number[], height: number): Promise<readonly { time: number; bitmap: ImageBitmap }[]>
	// Waveform peaks (0..1) for `columns` buckets over [range.start, range.end] from already-fetched data only;
	// NaN marks a bucket with no data yet. `onUpdate` fires as more blocks arrive.
	waveform(range: TimeRange, columns: number, onUpdate: (peaks: Float32Array) => void): () => void
	plan(recipe: VideoEditRecipe): Promise<ExportPlan>
	// A save (save.ts startVideoSave): a refusal and a file changed elsewhere are outcomes the editor words.
	exportVideo(
		recipe: VideoEditRecipe,
		target: VideoSaveTarget,
		onProgress: (progress: ExportProgress) => void
	): { done: Promise<VideoSaveOutcome>; cancel(): void; detachToTransfer(): void }
	dispose(): void
}
