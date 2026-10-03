import type { CompressEvent, CompressUpdate, ExtractUpdate, ManagedFuture, PauseSignal } from "@filen/sdk-rs"
import { log } from "@/lib/log"
import {
	compressEventToDTO,
	extractEventToDTO,
	freeSdkError,
	type CompressEventDTO,
	type Dto,
	type SlimExtractEvent
} from "@/lib/sdk/jobErrors"

// A transfer's or drive job's stop and pause. Aborting rejects an upload or download with kind
// "Cancelled" and ends a job with a "Cancelled" report; pausing never rejects, resume just continues
// the same future. The pause is a wasm-heap object and MUST be freed or it leaks wasm memory.
export interface JobControls {
	abort: AbortController
	pause: PauseSignal
}

// A job's callbacks as one stream to the caller, in the order the SDK makes them. They travel on the
// callback's own port and the result on the worker's, and two ports keep no order between them, so a
// call returns only once the caller has taken every event it sent. `start` binds the SDK's callbacks to
// plain worker-side functions: the wasm layer rejects the caller's proxy object itself.
export async function runOrderedJob<TEvent, TReport>(
	controls: JobControls,
	onEvent: (event: TEvent) => void | Promise<void>,
	start: (deliver: (event: TEvent) => void, managedFuture: ManagedFuture) => Promise<TReport>,
	label: string
): Promise<TReport> {
	// The reply to the last event means the caller ran every earlier one, which came before it on the
	// same port. Waiting on each instead would cost a round trip per update.
	let delivered: Promise<void> = Promise.resolve()

	const deliver = (event: TEvent): void => {
		// A caller that failed to take an event must not fail the job.
		delivered = Promise.resolve(onEvent(event)).catch((e: unknown) => {
			log.warn("sdk.worker", `${label} event delivery failed`, e)
		})
	}

	try {
		return await start(deliver, { abortSignal: controls.abort.signal, pauseSignal: controls.pause })
	} finally {
		await delivered
	}
}

export interface EventCapper<C extends string> {
	admit: (category: C) => boolean
	// What was refused since the last take.
	takeOmitted: () => Record<C, number>
}

// Per SDK call, as the SDK caps its report: past the cap an event is only counted, so a 50k-file
// archive does not clone 50k records across Comlink for the report to drop.
export function createEventCapper<C extends string>(caps: Record<C, number>): EventCapper<C> {
	const admitted = new Map<C, number>()
	const omitted = new Map<C, number>()

	return {
		admit: category => {
			const count = admitted.get(category) ?? 0

			if (count < caps[category]) {
				admitted.set(category, count + 1)

				return true
			}

			omitted.set(category, (omitted.get(category) ?? 0) + 1)

			return false
		},
		takeOmitted: () => {
			const taken = { ...caps }

			for (const category in taken) {
				taken[category] = omitted.get(category) ?? 0
			}

			omitted.clear()

			return taken
		}
	}
}

// The SDK's report cap.
const EVENT_CAP = 1000

export const COMPRESS_EVENT_CAPS = { skipped: EVENT_CAP, renamed: EVENT_CAP, hashMismatches: EVENT_CAP }
export const EXTRACT_EVENT_CAPS = { failures: EVENT_CAP, skipped: EVENT_CAP, renamed: EVENT_CAP, misleadingNames: EVENT_CAP }

export type CompressEventCategory = keyof typeof COMPRESS_EVENT_CAPS
export type ExtractEventCategory = keyof typeof EXTRACT_EVENT_CAPS

export interface CompressJobUpdate extends Omit<Dto<CompressUpdate>, "events"> {
	events: CompressEventDTO[]
	omitted: Record<CompressEventCategory, number>
}

// Past the cap, savedAsVersion counts the failures registered as a new version, macMetadata the skipped
// entries that were macOS metadata.
export interface ExtractJobOmitted extends Record<ExtractEventCategory, number> {
	savedAsVersion: number
	macMetadata: number
}

export interface ExtractJobUpdate extends Omit<Dto<ExtractUpdate>, "events"> {
	events: SlimExtractEvent[]
	omitted: ExtractJobOmitted
}

function compressEventCategory(event: CompressEvent): CompressEventCategory | null {
	switch (event.type) {
		case "skipped":
			return "skipped"
		case "renamed":
			return "renamed"
		case "sourceHashMismatch":
			return "hashMismatches"
		default:
			return null
	}
}

// Dispositions and propagation failures are never capped: one per source or created item, each
// changing what the drive holds.
export function slimCompressUpdate(update: CompressUpdate, capper: EventCapper<CompressEventCategory>): CompressJobUpdate {
	const events: CompressEventDTO[] = []

	for (const event of update.events) {
		const category = compressEventCategory(event)

		if (category === null || capper.admit(category)) {
			events.push(compressEventToDTO(event))
		}
	}

	return { ...update, events, omitted: capper.takeOmitted() }
}

// The per-file events nothing reads stay here: an update can carry a thousand of them. Trashed top-level
// folders, dispositions and propagation failures are never capped, each changing what the drive holds.
export function slimExtractUpdate(update: ExtractUpdate, capper: EventCapper<ExtractEventCategory>): ExtractJobUpdate {
	const events: SlimExtractEvent[] = []
	let savedAsVersion = 0
	let macMetadata = 0

	for (const event of update.events) {
		switch (event.type) {
			case "fileStarted":
			case "fileDone":
			case "dirCreated":
				continue
			case "dirFailed":
			case "fileFailed":
				if (!capper.admit("failures")) {
					if (event.stage.type === "registeredAsVersion") {
						savedAsVersion++
					}

					freeSdkError(event.error)

					continue
				}

				break
			case "skipped":
				if (!capper.admit("skipped")) {
					if (event.reason.type === "macMetadata") {
						macMetadata++
					}

					continue
				}

				break
			case "renamed":
				if (!capper.admit("renamed")) {
					continue
				}

				break
			case "misleadingName":
				if (!capper.admit("misleadingNames")) {
					continue
				}

				break
			default:
				break
		}

		events.push(extractEventToDTO(event))
	}

	return { ...update, events, omitted: { ...capper.takeOmitted(), savedAsVersion, macMetadata } }
}

// The SDK throws on an empty password: no password is `undefined`.
export function archivePassword(password: string | undefined): string | undefined {
	return password === "" ? undefined : password
}
