import type {
	ArchiveDisposalOutcome,
	ArchiveSourceDisposition,
	CompressEvent,
	CompressReport,
	CopyEvent,
	CopyFailure,
	CopyFailureInfo,
	CopyReport,
	CopyUpdate,
	ExtractEvent,
	ExtractFailureInfo,
	ExtractReport,
	FilenSdkError,
	ListReport
} from "@filen/sdk-rs"
import { toErrorDTO, type ErrorDTO } from "@/lib/sdk/errors"

// A job's progress and report hold live FilenSdkErrors, which clone hollow across Comlink (see
// errors.ts). The worker swaps each for its ErrorDTO before anything crosses, touching only the
// positions an error can sit in: an update can carry a thousand events, five times a second.

// What can hold no error, so maps to itself.
type ErrorFree = string | number | bigint | boolean | symbol | null | undefined | ((...args: never[]) => unknown) | ArrayBufferView

// `T` with every SDK error in it replaced by its ErrorDTO.
export type Dto<T> = unknown extends T
	? T
	: T extends FilenSdkError
		? ErrorDTO
		: T extends ErrorFree
			? T
			: T extends (infer U)[]
				? Dto<U>[]
				: T extends readonly (infer U)[]
					? readonly Dto<U>[]
					: { [K in keyof T]: Dto<T[K]> }

export type CopyFailureInfoDTO = Dto<CopyFailureInfo>
export type CopyFailureDTO = Dto<CopyFailure>
export type CopyEventDTO = Dto<CopyEvent>
export type CopyUpdateDTO = Dto<CopyUpdate>
export type CopyReportDTO = Dto<CopyReport>
export type ArchiveSourceDispositionDTO = Dto<ArchiveSourceDisposition>
export type ExtractFailureInfoDTO = Dto<ExtractFailureInfo>
export type CompressEventDTO = Dto<CompressEvent>
export type CompressReportDTO = Dto<CompressReport>
export type ExtractReportDTO = Dto<ExtractReport>
export type ListReportDTO = Dto<ListReport>

// The extract events that cross: the per-file ones nothing reads stay in the worker (driveJobRunner).
export type ExtractEventKept = Exclude<ExtractEvent, { type: "fileStarted" | "fileDone" | "dirCreated" }>
export type SlimExtractEvent = Dto<ExtractEventKept>

// A value already found to hold no error is its own DTO.
function errorFree<T>(value: T): Dto<T> {
	return value as Dto<T>
}

// Nothing reads the live error once it is converted, so its wasm memory goes now rather than at the
// finalizer's leisure.
export function liftError(error: FilenSdkError): ErrorDTO {
	const dto = toErrorDTO(error)

	freeSdkError(error)

	return dto
}

// For an error the worker drops unread.
export function freeSdkError(error: FilenSdkError): void {
	const free: unknown = (error as { free?: unknown }).free

	if (typeof free === "function") {
		error.free()
	}
}

function copyFailureInfoToDTO(info: CopyFailureInfo): CopyFailureInfoDTO {
	return { ...info, error: liftError(info.error) }
}

function copyEventToDTO(event: CopyEvent): CopyEventDTO {
	return "error" in event ? { ...event, error: liftError(event.error) } : event
}

export function copyUpdateToDTO(update: CopyUpdate): CopyUpdateDTO {
	return update.events.some(event => "error" in event) ? { ...update, events: update.events.map(copyEventToDTO) } : errorFree(update)
}

export function copyReportToDTO(report: CopyReport): CopyReportDTO {
	if (report.error === undefined && report.failures.length === 0) {
		return errorFree(report)
	}

	return {
		...report,
		failures: report.failures.map(failure => ({ ...failure, info: copyFailureInfoToDTO(failure.info) })),
		error: report.error === undefined ? undefined : liftError(report.error)
	}
}

function outcomeToDTO(outcome: ArchiveDisposalOutcome): Dto<ArchiveDisposalOutcome> {
	return outcome.type === "kept" && outcome.reason.type === "failed"
		? { ...outcome, reason: { type: "failed", error: liftError(outcome.reason.error) } }
		: errorFree(outcome)
}

function hasFailedDisposal(dispositions: readonly ArchiveSourceDisposition[]): boolean {
	return dispositions.some(({ outcome }) => outcome.type === "kept" && outcome.reason.type === "failed")
}

export function dispositionToDTO(disposition: ArchiveSourceDisposition): ArchiveSourceDispositionDTO {
	const outcome = outcomeToDTO(disposition.outcome)

	return outcome === disposition.outcome ? errorFree(disposition) : { ...disposition, outcome }
}

export function extractFailureToDTO(failure: ExtractFailureInfo): ExtractFailureInfoDTO {
	return { ...failure, error: liftError(failure.error) }
}

// The events compress and extract both post, alike in each.
type ArchiveJobEvent = Extract<CompressEvent, { type: "sourceDisposition" | "propagationFailed" }>

function archiveJobEventToDTO(event: ArchiveJobEvent): Dto<ArchiveJobEvent> {
	if (event.type === "propagationFailed") {
		return { ...event, error: liftError(event.error) }
	}

	const outcome = outcomeToDTO(event.outcome)

	return outcome === event.outcome ? errorFree(event) : { ...event, outcome }
}

export function compressEventToDTO(event: CompressEvent): CompressEventDTO {
	return event.type === "sourceDisposition" || event.type === "propagationFailed" ? archiveJobEventToDTO(event) : errorFree(event)
}

export function extractEventToDTO(event: ExtractEventKept): SlimExtractEvent {
	switch (event.type) {
		case "dirFailed":
		case "fileFailed":
			return { ...event, error: liftError(event.error) }
		case "sourceDisposition":
		case "propagationFailed":
			return archiveJobEventToDTO(event)
		default:
			return errorFree(event)
	}
}

export function compressReportToDTO(report: CompressReport): CompressReportDTO {
	if (report.error === undefined && !hasFailedDisposal(report.dispositions)) {
		return errorFree(report)
	}

	return {
		...report,
		dispositions: report.dispositions.map(dispositionToDTO),
		error: report.error === undefined ? undefined : liftError(report.error)
	}
}

export function extractReportToDTO(report: ExtractReport): ExtractReportDTO {
	if (report.error === undefined && report.failures.length === 0 && !hasFailedDisposal(report.dispositions)) {
		return errorFree(report)
	}

	return {
		...report,
		failures: report.failures.map(extractFailureToDTO),
		dispositions: report.dispositions.map(dispositionToDTO),
		error: report.error === undefined ? undefined : liftError(report.error)
	}
}

export function listReportToDTO(report: ListReport): ListReportDTO {
	return report.error === undefined ? errorFree(report) : { ...report, error: liftError(report.error) }
}
