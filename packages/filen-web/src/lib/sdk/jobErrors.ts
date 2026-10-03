import type { CopyEvent, CopyFailure, CopyFailureInfo, CopyReport, CopyUpdate, FilenSdkError } from "@filen/sdk-rs"
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

// A value already found to hold no error is its own DTO.
function errorFree<T>(value: T): Dto<T> {
	return value as Dto<T>
}

// Nothing reads the live error once it is converted, so its wasm memory goes now rather than at the
// finalizer's leisure.
export function liftError(error: FilenSdkError): ErrorDTO {
	const dto = toErrorDTO(error)
	const free: unknown = (error as { free?: unknown }).free

	if (typeof free === "function") {
		error.free()
	}

	return dto
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
