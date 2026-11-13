// The export worker's Comlink surface (export.worker.ts), as types only: the page binds to it without loading the
// worker's modules (mediabunny runs only in workers).
//
// The page side that drives a save end to end (offline gate, remote-change check, quota pre-check, the transfer row,
// the upload, wake lock, watch-state rebase) is videoEdit/save.ts's startVideoSave; a client spawns this worker
// through videoEdit/exportClient.ts and hands its remote to it.
//
// Contract for the frame pipeline the transcode path renders through (gl/pipeline.ts): frames arrive in the source's
// CODED orientation (the decoder never applies rotation metadata), and the recipe handed to render() is the user's
// recipe with `crop` mapped into coded space (null for the whole frame) and `rotate` the source's rotation plus the
// user's (plan.ts outputGeometry): crop, then rotate, then flip yields the output's display orientation at
// outWidth × outHeight. Text overlay positions stay in output space.

import type { EncodeCapabilities } from "@/lib/media/playback/capabilities.logic"
import type { ExportBlocker, PlanContext } from "@/features/preview/videoEdit/lib/plan"
import type { ExportPlan, VideoEditRecipe, VideoSourceInfo } from "@/features/preview/videoEdit/types"

export interface StartExportArgs {
	// Names the export for cancel().
	exportId: string
	// Serves the original's byte ranges (sdkApi.openRangePort's other end), transferred.
	source: MessagePort
	size: number
	recipe: VideoEditRecipe
	info: VideoSourceInfo
	caps: EncodeCapabilities
	context: PlanContext
	// The writing end of the save channel (@filen/shared/savePort) the SDK worker's uploadFileFromPort reads, transferred.
	output: MessagePort
	// The creation time (ms since the epoch) the output names when the source's own metadata has none: the drive file's.
	fallbackCreationTime: number | null
}

export interface ExportWorkerProgress {
	// Seconds of the output written so far (the slowest track's).
	outputSeconds: number
	outputDuration: number
	// Bytes handed to the upload.
	bytesWritten: number
}

// Why an export refused to run (or stopped) for reasons of its input, not a fault: the editor words them.
// "unavailable": the recipe uses what this browser cannot export (plan.ts exportBlockers); "gop": a copy fragment would exceed the iOS memory
// cap; "noVideo": the file has no video track the export reads; "codec": a track's codec cannot be copied or decoded.
export type ExportRefusal = "unavailable" | "gop" | "noVideo" | "codec"

export type ExportWorkerResult =
	| { status: "done"; bytes: number }
	| { status: "cancelled" }
	| { status: "error"; message: string; refusal: ExportRefusal | null; blockers?: readonly ExportBlocker[] }

export interface ExportWorkerApi {
	// planExport (lib/plan.ts) answered from the worker, for a client that already holds it.
	plan(recipe: VideoEditRecipe, source: VideoSourceInfo, caps: EncodeCapabilities, context?: PlanContext): ExportPlan
	// Runs one export into `args.output`. Resolves once the upload made the file ("done"), or with why not; never rejects.
	// The save is only committed (the upload allowed to finish) after the muxer finalised cleanly: a cancel or a failure
	// aborts the channel first, so no partial version is ever made. `onProgress` is a Comlink proxy, called at most
	// every PROGRESS_INTERVAL_MS.
	startExport(args: StartExportArgs, onProgress: (progress: ExportWorkerProgress) => unknown): Promise<ExportWorkerResult>
	// Stops the export named `exportId` (no-op once it ended).
	cancel(exportId: string): void
}

export const PROGRESS_INTERVAL_MS = 250
