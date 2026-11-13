import { PresentationError, refused, type PresentationRefusal } from "../../core/presentation/model"
import type { CallSignal } from "./engine"
import { isJobsPortEnd, type FromJobsPort, type JobPortMethod, type JobsPortEnd, type ToJobsPort } from "./engine/jobs"
import {
	runPresentationJob,
	type FromPresentationJobsWorker,
	type JobKind,
	type JobOutcome,
	type JobRequests,
	type JobSession,
	type ToPresentationJobsWorker
} from "./jobs/registry"
import type { PortLike, PresentationSessionApi } from "./protocol"
import { installJobsRealm, type JobsRealm } from "./raster"
import { savePortReader, savePortWriter, type SavePortEnd, type SavePortReader } from "@filen/shared/savePort"
import { offerSvgPort, workerSvgRasterizer, type SvgRasterizer } from "./svgPort"

// A presentation jobs worker (one per export or conversion, terminated afterwards) and the page's handle on one. The
// page makes two channels: one to the open deck's presentation worker (jobsPort), through which the job reads the
// session, unsaved edits included; one the job's bytes are pulled through (@filen/shared/savePort's protocol), which the page
// reads into a download. The worker never sees the deck's bytes or its password. SVG pictures are drawn on the page
// (svgPort.ts), for the PDF and the images alike.

// --- Worker side ---

export interface PresentationJobsWorkerScope {
	postMessage(message: unknown, transfer: unknown[]): void
	addEventListener(type: "message", listener: (event: { readonly data: unknown }) => void): void
	removeEventListener(type: "message", listener: (event: { readonly data: unknown }) => void): void
}

export type PresentationJobsWorkerOptions = JobsRealm

class JobCallError extends Error {
	readonly reason: PresentationRefusal

	constructor(reason: PresentationRefusal, message: string) {
		super(message)
		this.name = "JobCallError"
		this.reason = reason
	}
}

// The session as a job reads it: each call a message on the port, answered in kind.
export function jobSessionOver(port: JobsPortEnd): { readonly session: JobSession; close(): void } {
	let next = 1
	const waiting = new Map<number, { resolve: (value: unknown) => void; reject: (error: unknown) => void }>()
	const onMessage = (event: { readonly data: unknown }): void => {
		const message = event.data as FromJobsPort | null | undefined

		if (typeof message !== "object" || message === null || typeof message.id !== "number") return

		const entry = waiting.get(message.id)

		if (entry === undefined) return

		waiting.delete(message.id)

		if (message.t === "result") entry.resolve(message.value)
		else entry.reject(new JobCallError(message.reason, message.message))
	}
	const call = <T>(method: JobPortMethod, args: readonly unknown[], transfer: unknown[] = []): Promise<T> =>
		new Promise<T>((resolve, reject) => {
			const id = next++
			const request: ToJobsPort = { t: "call", id, method, args }

			waiting.set(id, { resolve: value => resolve(value as T), reject })
			port.postMessage(request, transfer)
		})

	port.addEventListener("message", onMessage)
	port.start?.()

	const session: JobSession = {
		render: (refs, options) => call("render", [refs, options]),
		media: (part, mediaPort) => call("media", [part, mediaPort], [mediaPort]),
		freshParts: (target, partsPort) => call("freshParts", [target, partsPort], [partsPort]),
		image: part => call("image", [part]),
		deckInfo: () => call("deckInfo", []),
		exportSlides: refs => call("exportSlides", [refs]),
		notesPage: slide => call("notesPage", [slide]),
		faces: () => call("faces", []),
		pdfSecurity: () => call("pdfSecurity", [])
	}

	return {
		session,
		close() {
			const close: ToJobsPort = { t: "close" }

			port.postMessage(close)
			port.removeEventListener("message", onMessage)

			for (const entry of waiting.values()) entry.reject(new JobCallError("closed", "the job ended"))

			waiting.clear()
			port.close()
		}
	}
}

function isRun(data: unknown): data is Extract<ToPresentationJobsWorker, { t: "run" }> {
	return typeof data === "object" && data !== null && Reflect.get(data, "t") === "run" && typeof Reflect.get(data, "id") === "number"
}

function isAbort(data: unknown): data is Extract<ToPresentationJobsWorker, { t: "abort" }> {
	return typeof data === "object" && data !== null && Reflect.get(data, "t") === "abort" && typeof Reflect.get(data, "id") === "number"
}

function outcomeOf(error: unknown, aborted: boolean): JobOutcome {
	if (aborted) return refused("aborted", "job")
	if (error instanceof JobCallError || error instanceof PresentationError) return refused(error.reason, error.message)

	return refused("failed", error instanceof Error ? error.message : String(error))
}

// Serves job runs on the worker's scope until the returned function stops it.
export function servePresentationJobsWorker(scope: PresentationJobsWorkerScope, options: PresentationJobsWorkerOptions): () => void {
	const running = new Map<number, { aborted: boolean; listeners: (() => void)[] }>()
	const svg = workerSvgRasterizer(scope)

	installJobsRealm(options.canvas === undefined ? options : { ...options, canvas: { ...options.canvas, svg: svg.rasterize } })

	const run = async (message: Extract<ToPresentationJobsWorker, { t: "run" }>): Promise<void> => {
		const state = { aborted: false, listeners: [] as (() => void)[] }
		const signal: CallSignal = {
			get aborted() {
				return state.aborted
			},
			onAbort: listener => {
				state.listeners.push(listener)
			}
		}
		const sessionPort = message.session
		const outputPort = message.output

		running.set(message.id, state)

		if (!isJobsPortEnd(sessionPort) || !isJobsPortEnd(outputPort)) {
			const outcome = refused("unsupported", "a job needs MessagePorts")

			scope.postMessage({ t: "done", id: message.id, outcome } satisfies FromPresentationJobsWorker, [])
			running.delete(message.id)

			return
		}

		const reader = jobSessionOver(sessionPort)
		const output = savePortWriter(outputPort as SavePortEnd)
		let outcome: JobOutcome

		output.announce()

		try {
			outcome = await runPresentationJob(message.kind, message.request as never, {
				session: reader.session,
				output,
				signal,
				progress: (done, total) => {
					scope.postMessage({ t: "progress", id: message.id, done, total } satisfies FromPresentationJobsWorker, [])
				}
			})
		} catch (error) {
			outcome = outcomeOf(error, state.aborted)
		} finally {
			reader.close()
		}

		if (outcome.kind === "done" && !state.aborted) output.commit()
		else output.abort(state.aborted ? "cancelled" : "refused")

		scope.postMessage({ t: "done", id: message.id, outcome } satisfies FromPresentationJobsWorker, [])
		running.delete(message.id)
	}

	const onMessage = (event: { readonly data: unknown }): void => {
		const data = event.data

		if (isAbort(data)) {
			const state = running.get(data.id)

			if (state !== undefined && !state.aborted) {
				state.aborted = true

				for (const listener of state.listeners.splice(0)) listener()
			}

			return
		}

		if (isRun(data)) void run(data)
	}

	scope.addEventListener("message", onMessage)

	return () => {
		scope.removeEventListener("message", onMessage)
		svg.stop()
		installJobsRealm(undefined)
	}
}

// --- Page side ---

// A Worker as the page drives it.
export interface PresentationJobsWorkerLike {
	postMessage(message: unknown, transfer: readonly unknown[]): void
	addEventListener(type: "message", listener: (event: { readonly data: unknown }) => void): void
	terminate(): void
}

interface ChannelLike {
	readonly port1: SavePortEnd
	readonly port2: SavePortEnd
}

function channel(): ChannelLike {
	const Channel: unknown = Reflect.get(globalThis, "MessageChannel")

	if (typeof Channel !== "function") throw new PresentationError("unsupported", "MessageChannel is not available")

	return new (Channel as new () => ChannelLike)()
}

export interface PresentationJobHandle {
	// The job's bytes, in order (undefined once all came); a read rejects when the job ended without them.
	readonly output: SavePortReader
	// The job's outcome (the worker is terminated once it is known).
	readonly done: Promise<JobOutcome>
	abort(): void
	// Ends the worker (once the output is read, or to give up on it).
	close(): void
}

// Runs one job on a fresh worker from `create`, reading `session` (its jobsPort serves the worker); the worker's SVG
// pictures are drawn by `svg` (the page's <img> rasteriser by default).
export function presentationJobsClient(
	create: () => PresentationJobsWorkerLike,
	options: { readonly svg?: SvgRasterizer } = {}
): <K extends JobKind>(
	kind: K,
	request: JobRequests[K],
	session: Pick<PresentationSessionApi, "jobsPort">,
	onProgress?: (done: number, total: number) => void
) => PresentationJobHandle {
	return (kind, request, session, onProgress) => {
		const worker = create()
		const closeSvg = offerSvgPort(worker, options.svg)
		const sessionChannel = channel()
		const outputChannel = channel()
		const output = savePortReader(outputChannel.port2)
		const id = 1
		let settled = false
		let finish: (outcome: JobOutcome) => void = () => undefined
		const done = new Promise<JobOutcome>(resolve => {
			finish = outcome => {
				if (settled) return

				settled = true
				resolve(outcome)
			}
		})

		worker.addEventListener("message", event => {
			const message = event.data as FromPresentationJobsWorker | null | undefined

			if (typeof message !== "object" || message === null || message.id !== id) return

			if (message.t === "progress") onProgress?.(message.done, message.total)
			else if (message.t === "done") finish(message.outcome)
		})

		session.jobsPort(sessionChannel.port1 as PortLike).catch((error: unknown) => {
			output.abort("failed")
			finish(outcomeOf(error, false))
		})

		const run = { t: "run", id, kind, request, session: sessionChannel.port2, output: outputChannel.port1 }

		worker.postMessage(run, [sessionChannel.port2, outputChannel.port1])

		return {
			output,
			done,
			abort() {
				if (settled) return

				worker.postMessage({ t: "abort", id } satisfies ToPresentationJobsWorker, [])
				output.abort("cancelled")
			},
			close() {
				if (!settled) {
					output.abort("cancelled")
					finish(refused("aborted", "job"))
				}

				closeSvg?.()
				worker.terminate()
			}
		}
	}
}
