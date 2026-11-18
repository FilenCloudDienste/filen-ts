import * as Comlink from "comlink"
import { sdkApi } from "@/lib/sdk/client"
import { runOp } from "@/lib/actions/outcome"
import { asErrorDTO, type ErrorDTO } from "@/lib/sdk/errors"
import type { EntryJobParams, EntryProgress } from "@/workers/sdk.worker"
import {
	isPickerCancelled,
	pipeToPickedFile,
	saveStreamDownload,
	type FsaSaveTarget,
	type SaveTarget,
	type SwSaveTarget
} from "@/features/drive/lib/saveDownload"
import { streamProducerToSw } from "@/features/drive/lib/swStreamProducer"
import { useTransfersStore, type TransfersStore } from "@/features/transfers/store/useTransfersStore"
import { settleTransferFailure, type DownloadOutcome } from "@/features/transfers/lib/settle"
import { toastTransferStarted } from "@/features/transfers/lib/transferStartToast"
import type { ArchiveSource } from "@/features/archive/lib/archiveSource"
import type { EntryStore } from "@/features/archive/lib/entryStore"
import { canReadEntry, maxSolidSkipFor } from "@/features/archive/lib/entryAccess.logic"
import { acquireArchiveReader } from "@/features/archive/lib/archiveReaders"

// One archive entry saved on its own, through the archive's reader (archiveReaders.ts): with the index the browser's
// listing left it, only the entry is read. Never for a selection, which extracts.

export interface EntryRequest {
	params: EntryJobParams
	// A public link's archive, read through the public-link client.
	anon: boolean
	name: string
	// As listed.
	size: number
}

// The call for a listed entry; null for one the SDK cannot read alone (a bare tar's member, a skipped entry,
// anything but a file), which must never reach it.
export function entryRequest(source: ArchiveSource, store: EntryStore, slot: number): EntryRequest | null {
	if (!canReadEntry(store, slot)) {
		return null
	}

	return {
		params: {
			archive: source.file,
			entry: { archive: source.uuid, index: store.index(slot) },
			maxSolidSkip: maxSolidSkipFor(store, slot)
		},
		anon: source.anon,
		name: store.name(slot),
		size: store.size(slot)
	}
}

export function isArchivePasswordError(dto: ErrorDTO): boolean {
	return dto.kind === "ArchivePasswordRequired" || dto.kind === "ArchiveWrongPassword"
}

export interface EntryDownloadReporters {
	progress: (bytesWritten: number) => void
	// Another archive job holds the page's slot.
	waiting: (waiting: boolean) => void
}

export interface RunEntryDownloadDeps {
	download: (
		request: EntryRequest,
		transferId: string,
		save: SaveTarget,
		password: string | undefined,
		report: EntryDownloadReporters
	) => Promise<boolean>
	store: Pick<TransfersStore, "add" | "setProgress" | "setWaitingForSlot" | "settle" | "remove">
	announceStart?: (name: string) => void
}

// A password the entry needs (or a wrong one) is no failure to keep: the caller asks and runs it again.
export type EntryDownloadOutcome = DownloadOutcome | { status: "password"; wrong: boolean }

// runDownload (download.ts) for an entry: the save target first, synchronously off the gesture (a cancelled
// picker is a no-op), then one transfers row, cancelled and paused by its id like a file's. `onVerified`
// runs only for an entry that arrived whole and matched its checksum: only then is the password it took
// proven (a 7z entry without a CRC decodes under a wrong one too).
export async function runEntryDownload(
	deps: RunEntryDownloadDeps,
	args: { request: EntryRequest; password: string | undefined; onVerified?: () => void }
): Promise<EntryDownloadOutcome> {
	const { request, password, onVerified } = args

	let save: SaveTarget
	try {
		save = await saveStreamDownload(request.name)
	} catch (e) {
		if (isPickerCancelled(e)) {
			return { status: "success" }
		}

		return { status: "error", dto: asErrorDTO(e) }
	}

	const id = crypto.randomUUID()

	deps.store.add({
		id,
		direction: "download",
		name: request.name,
		size: request.size,
		bytesTransferred: 0,
		status: "downloading",
		parentUuid: null,
		startedAt: Date.now(),
		...(save.kind === "sw" ? { browserManaged: true as const } : {})
	})
	deps.announceStart?.(request.name)

	let checked: boolean
	try {
		checked = await runOp(
			deps.download(request, id, save, password, {
				progress: bytes => {
					deps.store.setProgress(id, bytes)
				},
				waiting: waiting => {
					deps.store.setWaitingForSlot(id, waiting)
				}
			})
		)
	} catch (e) {
		const dto = asErrorDTO(e)

		if (isArchivePasswordError(dto)) {
			deps.store.settle(id, "cancelled")
			deps.store.remove(id)

			return { status: "password", wrong: dto.kind === "ArchiveWrongPassword" || password !== undefined }
		}

		if (settleTransferFailure(deps.store, id, dto)) {
			return { status: "success" }
		}

		return { status: "error", dto, ...(save.kind === "sw" ? { browserManaged: true as const } : {}) }
	}

	deps.store.settle(id, "done")

	if (checked) {
		onVerified?.()
	}

	return { status: "success" }
}

function progressProxy(report: EntryDownloadReporters): (progress: EntryProgress) => void {
	return Comlink.proxy((progress: EntryProgress) => {
		report.waiting(progress.phase === "waitingForWorker")
		report.progress(progress.bytesWritten)
	})
}

// Through the reader of the entry's archive under `password`, held for the call.
async function downloadThroughReader(
	request: EntryRequest,
	transferId: string,
	password: string | undefined,
	writable: WritableStream<Uint8Array>,
	report: EntryDownloadReporters
): Promise<boolean> {
	const reader = acquireArchiveReader(request.params.archive, request.anon, password)

	try {
		return await sdkApi.downloadReaderEntry(reader.id, transferId, request.params, writable, progressProxy(report))
	} finally {
		reader.release()
	}
}

// Through the service worker (streamProducerToSw), so a download that fails before its first byte (a wrong
// password) leaves no failed download in the browser.
function downloadEntryViaSw(
	request: EntryRequest,
	transferId: string,
	save: SwSaveTarget,
	password: string | undefined,
	report: EntryDownloadReporters
): Promise<boolean> {
	return streamProducerToSw(save, transferId, request.size, writable =>
		downloadThroughReader(request, transferId, password, Comlink.transfer(writable, [writable]), report)
	)
}

// Through the picked file, which a failure discards.
async function downloadEntryViaFsa(
	request: EntryRequest,
	transferId: string,
	save: FsaSaveTarget,
	password: string | undefined,
	report: EntryDownloadReporters
): Promise<boolean> {
	let checked = false

	await pipeToPickedFile(save, async transferred => {
		checked = await downloadThroughReader(request, transferId, password, transferred, report)
	})

	return checked
}

export const defaultEntryDownloadDeps: RunEntryDownloadDeps = {
	download: (request, transferId, save, password, report) =>
		save.kind === "fsa"
			? downloadEntryViaFsa(request, transferId, save, password, report)
			: downloadEntryViaSw(request, transferId, save, password, report),
	store: useTransfersStore.getState(),
	announceStart: name => {
		toastTransferStarted({ direction: "download", name, count: 1, noun: "items" })
	}
}
