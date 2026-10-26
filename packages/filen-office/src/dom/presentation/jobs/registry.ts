import type { ByteSink } from "../../../core/opc/index"
import type { Refused, SlideRef } from "../../../core/presentation/model"
import type { CallSignal } from "../engine"
import type { ConversionReport, PortLike, PresentationSessionApi } from "../protocol"
import { convertJob } from "./convert"
import { pdfJob } from "./pdf"
import { rasterJob } from "./raster"

// The jobs a presentation jobs worker runs (one per export, terminated afterwards), each in its own file with one
// owner. A job reads the open session, unsaved edits included, through a port to the presentation worker
// (jobsPort), slide by slide, and streams its output; it never receives the deck's password.

export type JobKind = "pdf" | "raster" | "convert"

export interface PdfJobRequest {
	readonly layout: "slides" | "notes" | "handouts"
	// Handouts: slides per page.
	readonly perPage?: 1 | 2 | 3 | 4 | 6 | 9
	// Every slide when absent.
	readonly slides?: readonly SlideRef[]
	readonly includeHidden: boolean
	// Encrypt with the source's password (asked of the session, never sent here).
	readonly protect: boolean
}

export interface RasterJobRequest {
	readonly format: "png" | "jpeg"
	readonly widthPx: number
	// JPEG, 0..1.
	readonly quality?: number
	readonly slides?: readonly SlideRef[]
	// Several images as one stored zip.
	readonly zip: boolean
}

export interface ConvertJobRequest {
	readonly target: "pptx" | "odp"
}

export interface JobRequests {
	readonly pdf: PdfJobRequest
	readonly raster: RasterJobRequest
	readonly convert: ConvertJobRequest
}

// The session as a job reads it.
export type JobSession = Pick<PresentationSessionApi, "render" | "media" | "freshParts">

export interface JobContext {
	readonly session: JobSession
	readonly output: ByteSink
	readonly signal: CallSignal
	progress(done: number, total: number): void
}

export type JobOutcome =
	{ readonly kind: "done"; readonly bytes: number; readonly contentType: string; readonly report?: ConversionReport } | Refused

export interface JobDefinition<K extends JobKind> {
	run(request: JobRequests[K], context: JobContext): Promise<JobOutcome>
}

export const PRESENTATION_JOBS: { readonly [K in JobKind]: JobDefinition<K> } = { pdf: pdfJob, raster: rasterJob, convert: convertJob }

export function runPresentationJob<K extends JobKind>(kind: K, request: JobRequests[K], context: JobContext): Promise<JobOutcome> {
	const job: JobDefinition<K> = PRESENTATION_JOBS[kind]

	return job.run(request, context)
}

export type JobRun = {
	readonly [K in JobKind]: { readonly t: "run"; readonly id: number; readonly kind: K; readonly request: JobRequests[K] }
}[JobKind]

// The page and a jobs worker: `session` is the port to the presentation worker's jobsPort, `output` the port the
// job's bytes are pulled through (the save port's pull protocol).
export type ToPresentationJobsWorker =
	(JobRun & { readonly session: PortLike; readonly output: PortLike }) | { readonly t: "abort"; readonly id: number }

export type FromPresentationJobsWorker =
	| { readonly t: "progress"; readonly id: number; readonly done: number; readonly total: number }
	| { readonly t: "done"; readonly id: number; readonly outcome: JobOutcome }
