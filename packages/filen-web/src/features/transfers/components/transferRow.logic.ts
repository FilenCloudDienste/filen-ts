import {
	computeTransfersSpeed,
	isActiveTransfer,
	type SpeedSample,
	type Transfer,
	type TransferDirection
} from "@/features/transfers/store/useTransfersStore"
import { fileIconKey, type FileIconKey } from "@/features/drive/lib/icon.logic"
import { clampedRatio, type DriveJobKind } from "@filen/shared"

// Per-row value fed straight into <Progress value={...}> (Base UI's 0-max range, max defaults to
// 100 — see ui/progress.tsx), scaled 0-100 same as useTransfersAggregate's own percent.
// - "done" is always 100, never derived from bytesTransferred: setProgress/settle are two separate
//   store writes (features/drive/lib/upload.ts's runUpload throttles the former), so a row can observably
//   settle to "done" a tick before its final bytesTransferred catches up to size. Trusting the
//   terminal status instead avoids a finished row momentarily rendering a not-quite-full bar.
// - "uploading"/"error" both read the live (or, for error, last-known) ratio — an error row keeps
//   the bar at wherever it stalled rather than resetting or hiding it, which stays honest about how
//   far the transfer actually got. Clamped defensively: nothing upstream guarantees
//   bytesTransferred never exceeds size.
export function transferProgress(transfer: Transfer): number {
	if (transfer.status === "done") {
		return 100
	}

	return clampedRatio(transfer.bytesTransferred, transfer.size, 100)
}

export type TransfersActiveKey =
	| "transfersStatusUploading"
	| "transfersStatusDownloading"
	| "transfersStatusCopying"
	| "transfersStatusCompressing"
	| "transfersStatusExtracting"
	| "transfersStatusPaused"
	| "transfersStatusWaitingForSlot"

export type TransfersFinishedKey =
	| "transfersStatusUploaded"
	| "transfersStatusDownloaded"
	| "transfersStatusCopied"
	| "transfersStatusCompressed"
	| "transfersStatusExtracted"
	| "transfersStatusCompletedWithErrors"
	| "transfersStatusError"

// An active row's status word, direction-aware. `paused` overrides direction: a suspended-in-place
// transfer (see Transfer["paused"]) isn't currently moving bytes, so it gets its own label instead of
// claiming to still be uploading/downloading (mirrors mobile's swap to a pause glyph in place of the
// live percentage). `waiting` is an archive job queued behind the page's one archive slot.
export function activeStatusLabelKey(direction: TransferDirection, paused = false, waiting = false): TransfersActiveKey {
	if (paused) {
		return "transfersStatusPaused"
	}

	if (waiting) {
		return "transfersStatusWaitingForSlot"
	}

	switch (direction) {
		case "upload":
			return "transfersStatusUploading"
		case "download":
			return "transfersStatusDownloading"
		case "copy":
			return "transfersStatusCopying"
		case "compress":
			return "transfersStatusCompressing"
		case "extract":
			return "transfersStatusExtracting"
	}
}

// A finished row's status word: what happened, in the transfer's own direction. A job that finished
// with some items failed is not a failed job.
export function finishedStatusLabelKey(status: Transfer["status"], direction: TransferDirection): TransfersFinishedKey {
	if (status === "completedWithErrors") {
		return "transfersStatusCompletedWithErrors"
	}

	if (status !== "done") {
		return "transfersStatusError"
	}

	switch (direction) {
		case "upload":
			return "transfersStatusUploaded"
		case "download":
			return "transfersStatusDownloaded"
		case "copy":
			return "transfersStatusCopied"
		case "compress":
			return "transfersStatusCompressed"
		case "extract":
			return "transfersStatusExtracted"
	}
}

// The label on a drive job row's button reopening its progress card.
export function jobDetailsLabelKey(
	kind: DriveJobKind
): "transfersRowCopyDetails" | "transfersRowCompressDetails" | "transfersRowExtractDetails" {
	switch (kind) {
		case "copy":
			return "transfersRowCopyDetails"
		case "compress":
			return "transfersRowCompressDetails"
		case "extract":
			return "transfersRowExtractDetails"
	}
}

export interface TransferRate {
	bytesPerSecond: number
	etaSeconds: number | null
}

// A running transfer's speed over its own rolling window, and the time left at that speed. Null while
// paused, finished, or before two samples span the window (nothing honest to show yet). A drive job
// reads its rate off its job instead (driveJobRate), which also counts the files it has not reached.
export function transferRate(transfer: Transfer, samples: readonly SpeedSample[]): TransferRate | null {
	if (!isActiveTransfer(transfer.status) || transfer.paused) {
		return null
	}

	const bytesPerSecond = computeTransfersSpeed(samples)

	if (bytesPerSecond <= 0) {
		return null
	}

	return {
		bytesPerSecond,
		etaSeconds: transfer.size > 0 ? steadyEtaSeconds(Math.max(0, transfer.size - transfer.bytesTransferred) / bytesPerSecond) : null
	}
}

// The time left, rounded up to a step that grows with it: a long wait read to the second changes on every
// progress tick even at a steady speed. Seconds under a minute, then 5 s, 30 s past ten minutes, and whole
// minutes past an hour.
export function steadyEtaSeconds(seconds: number): number {
	const step = seconds < 60 ? 1 : seconds < 600 ? 5 : seconds < 3_600 ? 30 : 60

	return Math.ceil(seconds / step) * step
}

// The row's leading type-icon key, resolved straight from the transfer's own file name — reuses
// drive's exact fileIconKey routing (icon.logic.ts) so a transfer row's glyph matches the one the same
// file shows once it lands in the listing. A transfer row carries no DriveItem (only name/size — see
// useTransfersStore.ts's Transfer shape), so there is no directory/file discriminant to branch on
// here: every row (upload or download) is file-shaped, including a zip download, whose suggested name
// always ends ".zip" and so already routes to the "archive" glyph rather than a generic one.
export function transferIconKey(transfer: Transfer): FileIconKey {
	return fileIconKey(transfer.name)
}

// A running transfer's 0-100 percent as the fraction percentFormat takes, floored: rounded, 99.5% would
// read "100%" before it is done. The epsilon keeps float error from flooring a whole value a step down
// (29 of 100 is 28.999…).
export function runningPercentFraction(percent: number): number {
	return Math.floor(percent + 1e-9) / 100
}

const percentFormats = new Map<string, Intl.NumberFormat>()

export function percentFormat(locale: string): Intl.NumberFormat {
	let format = percentFormats.get(locale)

	if (format === undefined) {
		format = new Intl.NumberFormat(locale, { style: "percent" })
		percentFormats.set(locale, format)
	}

	return format
}
