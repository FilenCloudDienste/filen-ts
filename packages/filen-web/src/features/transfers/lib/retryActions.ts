import { startUploads } from "@/features/drive/lib/upload"
import { startDownloads } from "@/features/drive/lib/download"
import { heicUploadConvertPreferenceCached } from "@/features/drive/queries/drive"
import { nativeTransfersAvailable } from "@/features/transfers/lib/nativeHost"
import { pickNativeUpload, startNativeUploads } from "@/features/transfers/lib/nativeTransfers"
import { retryUploadRows } from "@/features/transfers/lib/retry"
import { useTransfersStore, type Transfer } from "@/features/transfers/store/useTransfersStore"

// A transfer row's Retry and Upload again (transferRow.tsx), starting uploads as the upload menu does: through the
// desktop app's host where it runs.

function startFileUploads(files: File[], parentUuid: string | null): void {
	void (nativeTransfersAvailable() ? startNativeUploads(files, parentUuid) : startUploads(files, parentUuid))
}

// Re-runs the rows that can be: their uploads into the directory each went to, and each download as it was asked for.
export function retryTransfers(rows: readonly Transfer[]): void {
	for (const row of retryUploadRows(rows, startFileUploads)) {
		if (row.retry?.kind === "download") {
			void startDownloads(row.retry.items)
		}
	}
}

// "Upload again": the file picker, aimed at the failed row's directory; a pick replaces the row. On the desktop app
// without HEIC conversion its own open dialog, as the upload menu does (useUploadMenuActions.tsx).
export function uploadAgain(row: Transfer): void {
	const parentUuid = row.parentUuid

	if (nativeTransfersAvailable() && heicUploadConvertPreferenceCached() === false) {
		void pickNativeUpload("file", parentUuid).then(started => {
			if (started) {
				useTransfersStore.getState().remove(row.id)
			}
		})

		return
	}

	const input = document.createElement("input")

	input.type = "file"
	input.multiple = true
	input.hidden = true

	function done(): void {
		input.remove()
	}

	input.addEventListener("cancel", done, { once: true })
	input.addEventListener(
		"change",
		() => {
			const files = Array.from(input.files ?? [])

			done()

			if (files.length > 0) {
				useTransfersStore.getState().remove(row.id)
				startFileUploads(files, parentUuid)
			}
		},
		{ once: true }
	)
	// Attached while open: Safari opens no picker for a detached input.
	document.body.append(input)
	input.click()
}
