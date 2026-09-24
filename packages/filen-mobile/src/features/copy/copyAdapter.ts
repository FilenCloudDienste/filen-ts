import {
	type CopyEntry,
	type CopyError,
	type CopyEvent,
	CopyEvent_Tags,
	type CopyFailure,
	type CopyFailureInfo,
	CopyPhase,
	type CopyReport,
	CopyStage,
	type CopyUpdate,
	ErrorKind,
	type NonRootNormalItem,
	NonRootNormalItem_Tags
} from "@filen/sdk-rs"
import {
	createCopyJob as createSharedCopyJob,
	type CopyDestination,
	type CopyJob as SharedCopyJob,
	type CopyJobOutcome as SharedCopyJobOutcome,
	type CopyJobPhase,
	type CopyReportInput,
	type CopySettlement as SharedCopySettlement,
	type CopyUpdateEvents,
	type CopyUpdateInput
} from "@filen/shared"
import { unwrapDirMeta, unwrapFileMeta, unwrappedDirIntoDriveItem, unwrappedFileIntoDriveItem } from "@/lib/sdkUnwrap"
import { sdkErrorPartsToHumanReadable } from "@/lib/sdkErrors"
import type { DriveItem } from "@/types"

// The uniffi side of @filen/shared's copy job: maps the SDK's copy values onto its inputs.

export type { CopyDestination }

// `kind` is the ErrorKind member name, which is what the shared job logic compares against.
export type CopyJobError = {
	kind: string
	message: string
	serverMessage: string | undefined
}

export type CopyJobFailure = {
	sourceUuid: string
	sourcePath: string
	destName: string
	error: CopyJobError
	// A failed directory takes its whole subtree with it.
	affectedFiles: number
	affectedBytes: number
}

// The one item's kind, or several items: what a copy row shows as its icon.
export type CopyJobGlyph = "directory" | "file" | "items"

export type CopyJob = SharedCopyJob<DriveItem, CopyJobFailure, CopyFailure, CopyJobError> & {
	glyph: CopyJobGlyph
}

export type CopyJobOutcome = SharedCopyJobOutcome<CopyJobError>

export type CopySettlement = SharedCopySettlement<CopyJobFailure, CopyFailure, CopyJobError>

export function createCopyJob(id: string, destination: CopyDestination, itemCount: number, glyph: CopyJobGlyph): CopyJob {
	return {
		...createSharedCopyJob<DriveItem, CopyJobFailure, CopyFailure, CopyJobError>(id, destination, itemCount),
		glyph
	}
}

const PHASES: Record<CopyPhase, CopyJobPhase> = {
	[CopyPhase.Scanning]: "scanning",
	[CopyPhase.CreatingDirectories]: "creatingDirectories",
	[CopyPhase.CopyingFiles]: "copyingFiles",
	[CopyPhase.Finishing]: "finishing",
	[CopyPhase.Done]: "done",
	[CopyPhase.Cancelled]: "cancelled",
	[CopyPhase.Failed]: "failed"
}

export function copyJobPhase(phase: CopyPhase): CopyJobPhase {
	return PHASES[phase]
}

export function copyJobError(error: CopyError): CopyJobError {
	return {
		kind: ErrorKind[error.kind],
		message: error.message,
		serverMessage: error.serverMessage
	}
}

// What a copy's error row shows, with the same priority as every other SDK error.
export function copyJobErrorToHumanReadable(error: CopyJobError): string {
	const kind = ErrorKind[error.kind as keyof typeof ErrorKind] as ErrorKind | undefined

	return sdkErrorPartsToHumanReadable({
		kind: kind ?? ErrorKind.Internal,
		serverMessage: error.serverMessage,
		innerMessage: error.message
	})
}

// A file the backend registered as a new version of an existing one is stored, not failed: retrying
// would add yet another version, and it is not a copy to trash.
function isSavedAsVersion(info: CopyFailureInfo): boolean {
	return info.stage === CopyStage.RegisteredAsVersion
}

function toFailure(info: CopyFailureInfo): CopyJobFailure {
	return {
		sourceUuid: info.sourceUuid,
		sourcePath: info.sourcePath,
		destName: info.destName,
		error: copyJobError(info.error),
		affectedFiles: Number(info.affectedFiles),
		affectedBytes: Number(info.affectedBytes)
	}
}

export function emptyCopyEvents(): CopyUpdateEvents<CopyJobFailure> {
	return {
		failures: [],
		savedAsVersion: 0,
		renamed: 0,
		propagationFailed: 0
	}
}

// Folds an update's events into `into`: only those naming something the user may act on or be told
// about. Skipped entries are already counted in the update's own counts.
export function collectCopyEvents(events: readonly CopyEvent[], into: CopyUpdateEvents<CopyJobFailure>): void {
	for (const event of events) {
		switch (event.tag) {
			case CopyEvent_Tags.DirFailed:
			case CopyEvent_Tags.FileFailed: {
				const [info] = event.inner

				if (isSavedAsVersion(info)) {
					into.savedAsVersion++
				} else {
					into.failures.push(toFailure(info))
				}

				break
			}

			case CopyEvent_Tags.Renamed: {
				into.renamed++

				break
			}

			case CopyEvent_Tags.PropagationFailed: {
				into.propagationFailed++

				break
			}

			default: {
				break
			}
		}
	}
}

export function copyUpdateInput(update: CopyUpdate, events: CopyUpdateEvents<CopyJobFailure>): CopyUpdateInput<CopyJobFailure> {
	return {
		phase: copyJobPhase(update.phase),
		pausing: update.pausing,
		paused: update.paused,
		cancelling: update.cancelling,
		scan: update.scan,
		totals: update.totals,
		counts: update.counts,
		active: update.active,
		bytesPerSecond: update.bytesPerSecond,
		etaMs: update.etaMs,
		events
	}
}

export function copyReportInput(report: CopyReport): CopyReportInput<CopyJobFailure, CopyFailure, CopyJobError> {
	const failures = report.failures.filter(failure => !isSavedAsVersion(failure.info))

	return {
		createdCount: report.topLevel.length,
		totals: report.totals,
		counts: report.counts,
		failures: failures.map(failure => ({
			failure: toFailure(failure.info),
			retryable: failure
		})),
		savedAsVersionCount: report.failures.length - failures.length,
		renamedCount: report.renamed.length,
		error: report.error === undefined ? undefined : copyJobError(report.error)
	}
}

// The existing files a copy was registered as a new version of: never trashed as "copied".
export function versionTargets(report: CopyReport): Set<string> {
	const targets = new Set<string>()

	for (const failure of report.failures) {
		if (isSavedAsVersion(failure.info) && failure.info.existingFile !== undefined) {
			targets.add(failure.info.existingFile)
		}
	}

	return targets
}

export function createdDriveItem(item: NonRootNormalItem): DriveItem {
	switch (item.tag) {
		case NonRootNormalItem_Tags.Dir: {
			return unwrappedDirIntoDriveItem(unwrapDirMeta(item.inner[0]))
		}

		case NonRootNormalItem_Tags.File: {
			return unwrappedFileIntoDriveItem(unwrapFileMeta(item.inner[0]))
		}
	}
}

// Each failed item goes back to the directory it was meant for, under the name it was planned with.
export function retryEntries(failures: readonly CopyFailure[]): CopyEntry[] {
	return failures.map(failure => ({
		item: failure.item,
		destination: failure.info.destParentDir,
		name: failure.info.destName
	}))
}
