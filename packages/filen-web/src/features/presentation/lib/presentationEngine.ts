import {
	presentationWorkerPool,
	type PresentationEvent,
	type PresentationOpenOptions,
	type PresentationWorkerLike,
	type PresentationWorkerPool,
	type SourceSpec
} from "@filen/office/dom/presentation"
import type { PresentationConnection } from "@filen/office/react/presentation"
import PresentationWorker from "@/features/presentation/workers/presentation.worker.ts?worker"
import { recoverIfNewerBuild } from "@/lib/appUpdate"

// The page's side of the presentation workers (the package, model, text layout and rendering all live there): one
// worker per open deck, and a closed deck's worker kept for a minute for the next one, which then skips start-up and
// the fonts it already fetched. None of the engine is in the main bundle.

export const PRESENTATION_WORKER_IDLE_MS = 60_000

// A Worker as the pool drives it. A deploy that changed the worker removes its old file (appUpdate.ts).
function presentationWorker(): PresentationWorkerLike {
	const worker = new PresentationWorker()

	worker.addEventListener("error", () => {
		recoverIfNewerBuild()
	})

	return {
		postMessage: (message, transfer) => {
			worker.postMessage(message, transfer as Transferable[])
		},
		addEventListener: (type: "message" | "error", listener: (event: { readonly data: unknown }) => void) => {
			if (type === "message") {
				worker.addEventListener("message", listener)
			} else {
				worker.addEventListener("error", () => {
					listener({ data: undefined })
				})
			}
		},
		terminate: () => {
			worker.terminate()
		}
	}
}

export const presentationPool: PresentationWorkerPool = presentationWorkerPool(presentationWorker, PRESENTATION_WORKER_IDLE_MS)

// Opens `source` on a pooled worker, as the viewer's store asks (once per open): the session, the password answer,
// and the session's end.
export function connectPresentation(
	pool: PresentationWorkerPool,
	source: SourceSpec,
	listener: (event: PresentationEvent) => void,
	options: PresentationOpenOptions
): PresentationConnection {
	const client = pool.open(source, options, listener)

	return {
		session: client,
		unlock: password => {
			client.unlock(password)
		},
		abort: call => {
			client.abort(call)
		},
		dispose: () => {
			client.close()
		}
	}
}
