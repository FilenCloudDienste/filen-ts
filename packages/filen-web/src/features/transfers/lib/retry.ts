import { isDirectoryRunRow, useTransfersStore, type Transfer } from "@/features/transfers/store/useTransfersStore"

// Running a failed transfer again, from what its row kept (Transfer.retry): the user's own request, so no retry
// policy of the SDK's is repeated here. A retried row leaves the list; the new run adds its own. Imports nothing that
// starts a transfer, so the upload runners can offer it (retryActions.ts starts them for a row).

export type StartFileUploads = (files: File[], parentUuid: string | null) => void

export function canRetry(transfer: Transfer): boolean {
	return transfer.status === "error" && transfer.retry !== undefined
}

// A failed file upload whose File is gone (a desktop app native upload reads paths the page never held): the picker
// opens on its directory instead.
export function canUploadAgain(transfer: Transfer): boolean {
	return transfer.direction === "upload" && transfer.status === "error" && transfer.retry === undefined && !isDirectoryRunRow(transfer)
}

// Takes the retryable rows out of the list and re-runs their uploads into the directory each went to, one run per
// directory. Returns the download rows among them, for the caller to start.
export function retryUploadRows(rows: readonly Transfer[], start: StartFileUploads): Transfer[] {
	const uploads = new Map<string | null, File[]>()
	const downloads: Transfer[] = []
	const retried = new Set<string>()

	for (const row of rows) {
		if (row.status !== "error" || row.retry === undefined) {
			continue
		}

		retried.add(row.id)

		if (row.retry.kind === "download") {
			downloads.push(row)

			continue
		}

		const files = uploads.get(row.parentUuid)

		if (files === undefined) {
			uploads.set(row.parentUuid, [row.retry.file])
		} else {
			files.push(row.retry.file)
		}
	}

	if (retried.size > 0) {
		useTransfersStore.getState().removeMany(retried)
	}

	for (const [parentUuid, files] of uploads) {
		start(files, parentUuid)
	}

	return downloads
}

// The summary toast's "Retry failed" for the upload runs `batchIds`: the retryable failed rows they left, read again
// when clicked (one removed meanwhile stays removed). Undefined when none can be retried.
export function retryFailedRuns(batchIds: ReadonlySet<string>, start: StartFileUploads): (() => void) | undefined {
	function failedRows(): Transfer[] {
		return useTransfersStore
			.getState()
			.transfers.filter(transfer => transfer.batch !== undefined && batchIds.has(transfer.batch.id) && canRetry(transfer))
	}

	if (failedRows().length === 0) {
		return undefined
	}

	return () => {
		retryUploadRows(failedRows(), start)
	}
}
