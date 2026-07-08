import * as Comlink from "comlink"
import type { AnyFile } from "@filen/sdk-rs"
import { toast } from "sonner"
import { sdkApi } from "@/lib/sdk/client"
import { i18n } from "@/lib/i18n"
import { runOp, type VoidActionOutcome } from "@/lib/actions/outcome"
import { asErrorDTO } from "@/lib/sdk/errors"
import { asDirectoryOrFile, type DriveItem } from "@/lib/drive/item"
import { throttle, PROGRESS_THROTTLE_MS } from "@/lib/drive/upload"
import { saveDownload, triggerSwDownload, isPickerCancelled, type SaveTarget, type FsaSaveTarget } from "@/lib/drive/save-download"
import { useTransfersStore, type TransfersStore } from "@/stores/transfers"
import { log } from "@/lib/log"

// Extracts the SDK AnyFile a download op wants from a DriveItem's file arm. A directory item is a
// contract violation here — startDownloads below routes any directory to the zip path instead — so
// this throws rather than silently downloading nothing; runDownload's own try/catch turns that into
// a clean error outcome before anything (a save dialog, a transfer row) is shown for it.
export function narrowToAnyFile(item: DriveItem): AnyFile {
	const base = asDirectoryOrFile(item)

	if (base.type === "directory") {
		throw new Error("narrowToAnyFile: directory item cannot be downloaded as a file")
	}

	// `base.data` (File & ExtraData & {decryptedMeta}) is a structural superset of File — assignable
	// to AnyFile with no adapter, same reasoning as sdk.worker.ts's held-item rename/move/trash ops.
	return base.data
}

// DI mirror of RunUploadDeps (lib/drive/upload.ts), minus patchListing — a download is read-only
// w.r.t. the drive, so there is no cache to patch on success. `cancel` is unused by runDownload
// itself (there is no cancel UI yet); it exists so a later cancel control can call
// defaultDownloadDeps.cancel(transferId) without another store/deps shape change.
export interface RunDownloadDeps {
	download: (file: AnyFile, transferId: string, save: SaveTarget, onProgress: (bytes: bigint) => void) => Promise<void>
	cancel?: (transferId: string) => void
	store: Pick<TransfersStore, "add" | "setProgress" | "settle" | "remove">
}

// One download attempt: resolve where it saves to (a picker-cancel here is a clean no-op, never an
// error — the user simply chose not to save), register it in the transfers store, stream it through
// the injected `download` op with THROTTLED progress, then settle. `Cancelled` (the SDK's abort
// rejection kind — see sdk.worker.ts's downloadFileToWriter) removes the row entirely rather than
// leaving a finished entry behind (mobile parity: an aborted transfer has no history). Never throws;
// LABEL-FIRST via runOp/asErrorDTO, mirroring runUpload. No listing patch — downloads don't mutate
// the drive.
export async function runDownload(deps: RunDownloadDeps, args: { item: DriveItem }): Promise<VoidActionOutcome> {
	const { item } = args

	let file: AnyFile
	try {
		file = narrowToAnyFile(item)
	} catch (e) {
		return { status: "error", dto: asErrorDTO(e) }
	}

	const id = crypto.randomUUID()
	const name = item.data.decryptedMeta?.name ?? item.data.uuid

	let save: SaveTarget
	try {
		save = await saveDownload(name)
	} catch (e) {
		if (isPickerCancelled(e)) {
			return { status: "success" }
		}

		return { status: "error", dto: asErrorDTO(e) }
	}

	deps.store.add({
		id,
		direction: "download",
		name,
		size: Number(item.data.size),
		bytesTransferred: 0,
		status: "downloading",
		parentUuid: null,
		startedAt: Date.now()
	})

	const reportProgress = throttle((bytes: bigint) => {
		deps.store.setProgress(id, Number(bytes))
	}, PROGRESS_THROTTLE_MS)

	try {
		await runOp(deps.download(file, id, save, reportProgress))
	} catch (e) {
		const dto = asErrorDTO(e)

		if (dto.kind === "Cancelled") {
			deps.store.settle(id, "cancelled")
			deps.store.remove(id)

			return { status: "success" }
		}

		deps.store.settle(id, "error", dto)

		return { status: "error", dto }
	}

	deps.store.settle(id, "done")

	return { status: "success" }
}

// The FSA sink wiring: a main-thread TransformStream bridges the worker call (its `writable` end,
// Comlink.transfer'd in — the worker pulls decrypted bytes into it) and the real on-disk sink (its
// `readable` end piped to the FSA writable). COORDINATED TEARDOWN: if the worker call rejects (e.g.
// cancelDownload aborted it), the SDK may leave the transferred writable OPEN, so the pipe is
// aborted here too via the shared AbortSignal — otherwise a naive `readable` consumer hangs forever
// on an open-but-abandoned stream. On success, `sinkDone` is awaited too so this only resolves once
// the FSA file is actually finished writing, not merely once the worker call returns.
async function downloadViaFsa(file: AnyFile, transferId: string, save: FsaSaveTarget, onProgress: (bytes: bigint) => void): Promise<void> {
	const transform = new TransformStream<Uint8Array, Uint8Array>()
	const teardown = new AbortController()
	const sinkDone = transform.readable.pipeTo(save.writable, { signal: teardown.signal }).catch(() => undefined)

	try {
		await sdkApi.downloadFileToWriter(
			file,
			transferId,
			Comlink.transfer(transform.writable, [transform.writable]),
			Comlink.proxy(onProgress)
		)
	} catch (e) {
		teardown.abort()
		await sinkDone

		throw e
	}

	await sinkDone
}

// The real wiring behind RunDownloadDeps.download: branches on SaveTarget.kind, applying
// Comlink.transfer/Comlink.proxy on the fsa branch (mirrors defaultUploadDeps' Comlink.proxy wrap).
// The sw branch has no per-byte progress to report — the browser's own download manager takes over
// once the navigation triggers, invisible to page JS from that point on (same as a plain `<a
// href="file">` download).
export const defaultDownloadDeps: RunDownloadDeps = {
	download: (file, transferId, save, onProgress) =>
		save.kind === "fsa" ? downloadViaFsa(file, transferId, save, onProgress) : triggerSwDownload(file, save),
	cancel: transferId => {
		void sdkApi.cancelDownload(transferId)
	},
	store: useTransfersStore.getState()
}

// Directory + multi-select zip download (the SDK's downloadItemsToZip) lands in a later task. This
// placeholder keeps startDownloads' single-vs-zip routing decision compilable and testable ahead of
// that work landing — it is not reachable from any shipped UI yet (no entry point calls
// startDownloads with more than one item, or a directory, today).
export function startZipDownload(items: DriveItem[]): Promise<void> {
	log.warn("download", "startZipDownload: not implemented yet", { count: items.length })

	return Promise.resolve()
}

// A directory, or more than one item at all, zips into one archive rather than N separate save
// dialogs — the SDK does the recursion + zip in one native call, the exact inverse of upload's own
// JS-orchestrated multi-file fan-out. Only a lone file downloads directly. Exported as the single
// gate every download entry point (item-menu/bulk-bar/keymap) enables on: a lone file is
// enabled, anything else is disabled until the zip path lands.
export function needsZip(items: DriveItem[]): boolean {
	return items.length > 1 || items.some(item => asDirectoryOrFile(item).type === "directory")
}

// The one call a download entry point makes. Mirrors startUploads' partial-failure toast
// (lib/drive/upload.ts) on error, but deliberately drops the success toast: runDownload's return is
// the shared 2-state VoidActionOutcome, so a user cancelling the save picker (a clean no-op) is
// INDISTINGUISHABLE here from a real completed download — both resolve {status:"success"}. Rather
// than widen that cross-cutting type, this just never claims "downloaded" on success; the transfers
// row it creates is already the signal that a download started and finished.
export async function startDownloads(items: DriveItem[]): Promise<void> {
	if (items.length === 0) {
		return
	}

	if (needsZip(items)) {
		await startZipDownload(items)

		return
	}

	const [item] = items

	if (item === undefined) {
		return
	}

	const outcome = await runDownload(defaultDownloadDeps, { item })

	if (outcome.status === "error") {
		toast.error(i18n.t("transfers:transfersDownloadSummaryCompleteWithFailures", { count: 0, failed: 1 }))
	}
}
