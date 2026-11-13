import * as Comlink from "comlink"
import RenderWorker from "@/features/preview/imageEdit/worker/render.worker.ts?worker"
import type { RenderWorkerApi } from "@/features/preview/imageEdit/worker/render.worker"
import type { EditCapabilities, EditSession, ImageEditSource } from "@/features/preview/imageEdit/types"
import { idleResource } from "@/lib/idleResource"
import { isAppleMobile } from "@/lib/appleMobile"
import { recoverIfNewerBuild } from "@/lib/appUpdate"

// The image editor's render worker, spun up on Edit. Each open session holds ONE use of it for its whole life,
// so the idle teardown (which frees the full-resolution source, the GPU context and the JPEG codec's wasm heap,
// which never shrinks) only starts once the editor is left.
const RENDER_WORKER_IDLE_MS = 30_000

// The largest source an export takes: its RGBA buffer, the encoder's copy and the GPU tiles must fit a tab.
// iOS and iPadOS kill a tab far sooner than desktop engines do.
const MAX_PIXELS_DESKTOP = 50_000_000
const MAX_PIXELS_IOS = 16_000_000

interface RenderWorkerResource {
	worker: Worker
	remote: Comlink.Remote<RenderWorkerApi>
}

let live: RenderWorkerResource | null = null

const renderWorker = idleResource<RenderWorkerResource>(
	() => {
		const worker = new RenderWorker()
		const resource: RenderWorkerResource = { worker, remote: Comlink.wrap<RenderWorkerApi>(worker) }

		worker.addEventListener("error", () => {
			// A deploy that changed this worker removes its old file (appUpdate.ts).
			recoverIfNewerBuild()
			renderWorker.invalidate(resource)
		})

		live = resource

		return resource
	},
	resource => {
		if (live === resource) {
			live = null
		}

		resource.remote[Comlink.releaseProxy]()
		resource.worker.terminate()
	},
	RENDER_WORKER_IDLE_MS
)

// Ends every open session's hold, for logout.
const openSessions = new Set<() => void>()

// Device facts do not change within a tab: asked of the first session's worker only.
let capabilities: Promise<EditCapabilities> | null = null

function maxPixels(): number {
	return isAppleMobile() ? MAX_PIXELS_IOS : MAX_PIXELS_DESKTOP
}

function probe(remote: Comlink.Remote<RenderWorkerApi>): Promise<EditCapabilities> {
	capabilities ??= remote.probe().then(
		result => ({ ...result, maxPixels: maxPixels() }),
		(error: unknown) => {
			capabilities = null

			throw error
		}
	)

	return capabilities
}

// Pixels cross to the worker by transfer: the bitmap or buffer is detached here.
function transferred(source: ImageEditSource): ImageEditSource {
	switch (source.kind) {
		case "blob":
			return source
		case "bitmap":
			return Comlink.transfer(source, [source.bitmap])
		case "rgba":
			return Comlink.transfer(source, [source.data.buffer])
	}
}

function closedError(): Error {
	return new Error("image edit session closed")
}

// A WebGL context loss during an export rejects with an error of this name; the export can simply be retried
// once the context is restored.
export function isContextLostError(error: unknown): boolean {
	return error instanceof Error && error.name === "ContextLostError"
}

export async function openEditSession(): Promise<{ session: EditSession; capabilities: EditCapabilities }> {
	const hold = Promise.withResolvers<undefined>()
	const acquired = Promise.withResolvers<RenderWorkerResource>()

	renderWorker
		.use(async resource => {
			acquired.resolve(resource)
			await hold.promise
		})
		// A worker that failed to start: nothing is held.
		.catch((error: unknown) => {
			acquired.reject(error)
		})

	const { remote } = await acquired.promise
	let closed = false

	const end = (): void => {
		if (!closed) {
			closed = true
			openSessions.delete(end)
			hold.resolve(undefined)
		}
	}

	openSessions.add(end)

	const opened = await Promise.all([remote.open(), probe(remote)]).catch((error: unknown) => {
		end()

		throw error
	})
	const [id, caps] = opened

	const session: EditSession = {
		attach: async (canvas, cssWidth, cssHeight, devicePixelRatio) => {
			if (closed) {
				throw closedError()
			}

			await remote.attach(id, Comlink.transfer(canvas, [canvas]), cssWidth, cssHeight, devicePixelRatio)
		},
		resize: (cssWidth, cssHeight, devicePixelRatio) => {
			if (!closed) {
				remote.resize(id, cssWidth, cssHeight, devicePixelRatio).catch(() => undefined)
			}
		},
		load: async (source, info) => {
			if (closed) {
				throw closedError()
			}

			return await remote.load(id, transferred(source), info)
		},
		// Fire and forget: the worker keeps only the latest recipe and draws it on its next frame.
		render: (recipe, options) => {
			if (!closed) {
				remote.render(id, recipe, options).catch(() => undefined)
			}
		},
		filterThumbnails: async (recipe, size) => {
			if (closed) {
				throw closedError()
			}

			return await remote.filterThumbnails(id, recipe, size)
		},
		export: async (recipe, target, meta) => {
			if (closed) {
				throw closedError()
			}

			return await remote.export(id, recipe, target, meta)
		},
		// Frees the session in the worker, then lets the idle teardown start (the close is already posted, so it
		// runs before any teardown could).
		close: () => {
			if (closed) {
				return
			}

			remote.close(id).catch(() => undefined)
			end()
		}
	}

	return { session, capabilities: caps }
}

// Logout: the worker held this account's picture at full resolution; it goes now, open session or not.
export function releaseImageEditWorker(): void {
	for (const end of [...openSessions]) {
		end()
	}

	if (live === null) {
		renderWorker.disposeIfIdle()
	} else {
		renderWorker.invalidate(live)
	}
}
