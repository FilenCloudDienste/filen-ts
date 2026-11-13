import * as Comlink from "comlink"
import ExportWorker from "@/features/preview/videoEdit/worker/export.worker.ts?worker"
import type {
	ExportWorkerApi,
	ExportWorkerProgress,
	ExportWorkerResult,
	StartExportArgs
} from "@/features/preview/videoEdit/worker/exportApi"
import { idleResource } from "@/lib/idleResource"
import { recoverIfNewerBuild } from "@/lib/appUpdate"

// The page's handle on the export worker, spun up for an export (or a plan) and torn down once idle: the demuxer, the
// codecs and the GPU pass are freed with it.
const EXPORT_WORKER_IDLE_MS = 30_000

interface ExportWorkerResource {
	worker: Worker
	remote: Comlink.Remote<ExportWorkerApi>
	// Settles when the worker died (a crash, an out-of-memory kill): a call in flight would never answer.
	lost: Promise<string>
}

const exportWorker = idleResource<ExportWorkerResource>(
	() => {
		const worker = new ExportWorker({ name: "video-export" })
		const lost = Promise.withResolvers<string>()
		const resource: ExportWorkerResource = { worker, remote: Comlink.wrap<ExportWorkerApi>(worker), lost: lost.promise }

		worker.addEventListener("error", event => {
			// A deploy that changed this worker removes its old file (appUpdate.ts).
			recoverIfNewerBuild()
			lost.resolve(event.message || "the export worker stopped")
			exportWorker.invalidate(resource)
		})

		return resource
	},
	resource => {
		resource.remote[Comlink.releaseProxy]()
		resource.worker.terminate()
	},
	EXPORT_WORKER_IDLE_MS
)

// One export run in the worker: its answer, and how to stop it.
export interface ExportRun {
	result: Promise<ExportWorkerResult>
	cancel(): void
}

export interface Exporter {
	run(args: StartExportArgs, onProgress: (progress: ExportWorkerProgress) => void): ExportRun
}

// The worker holds one use for the export's whole life, so its idle teardown never cuts one short.
export const exporter: Exporter = {
	run(args, onProgress) {
		let live: ExportWorkerResource | null = null
		let cancelled = false
		const result = exportWorker.use(async resource => {
			live = resource

			if (cancelled) {
				args.source.close()
				args.output.close()

				return { status: "cancelled" } satisfies ExportWorkerResult
			}

			return await Promise.race([
				resource.remote.startExport(Comlink.transfer(args, [args.source, args.output]), Comlink.proxy(onProgress)),
				resource.lost.then((message): ExportWorkerResult => ({ status: "error", message, refusal: null, cause: "workerLost" }))
			])
		})

		return {
			result: result.catch((error: unknown): ExportWorkerResult => ({
				status: "error",
				message: error instanceof Error ? error.message : String(error),
				refusal: null
			})),
			cancel: () => {
				cancelled = true

				void live?.remote.cancel(args.exportId).catch(() => undefined)
			}
		}
	}
}
