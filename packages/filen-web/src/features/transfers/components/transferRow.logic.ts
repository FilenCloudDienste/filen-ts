import { type Transfer } from "@/features/transfers/store/useTransfersStore"
import { fileIconKey, type FileIconKey } from "@/features/drive/lib/icon.logic"

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

	if (transfer.size <= 0) {
		return 0
	}

	return Math.min(100, Math.max(0, (transfer.bytesTransferred / transfer.size) * 100))
}

// The active-row status icon's sr-only label key, direction-aware — isActiveTransfer's two members
// ("uploading"/"downloading") each get their own announcement instead of the row hard-coding the
// upload one for both directions. `paused` overrides direction: a suspended-in-place transfer (see
// Transfer["paused"]) isn't currently sending/receiving bytes, so it gets its own label instead of
// claiming to still be uploading/downloading (mirrors mobile's swap to a pause glyph in place of the
// live percentage). Defaults to false so every pre-existing direction-only call site is unaffected.
export function activeStatusLabelKey(
	direction: Transfer["direction"],
	paused = false
): "transfersStatusUploading" | "transfersStatusDownloading" | "transfersStatusPaused" {
	if (paused) {
		return "transfersStatusPaused"
	}

	return direction === "upload" ? "transfersStatusUploading" : "transfersStatusDownloading"
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
