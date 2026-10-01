import * as Comlink from "comlink"
import type { AnyItemWithContext } from "@filen/sdk-rs"
import { driveItemName } from "@filen/shared"
import { toast } from "sonner"
import { sdkApi } from "@/lib/sdk/client"
import { i18n } from "@/lib/i18n"
import { runOp, type VoidActionOutcome } from "@/lib/actions/outcome"
import { asErrorDTO } from "@/lib/sdk/errors"
import { pipeWorkerToSink } from "@/lib/pipeWorkerToSink"
import { isDirectoryItem, narrowToSdkItems, type DriveItem } from "@/features/drive/lib/item"
import { throttle, PROGRESS_THROTTLE_MS } from "@/lib/throttle"
import {
	saveDownload,
	triggerSwZipDownload,
	isPickerCancelled,
	type SaveTarget,
	type FsaSaveTarget
} from "@/features/drive/lib/saveDownload"
import { useTransfersStore, type TransfersStore } from "@/features/transfers/store/useTransfersStore"
import { settleTransferFailure } from "@/features/transfers/lib/settle"
import { toastDownloadStarted } from "@/features/transfers/lib/downloadStartToast"

// DI mirror of RunDownloadDeps (download.ts) for the zip path — one archive, one transfer row, one
// save dialog. No `cancel` field: cancelTransfer/setTransferPaused (features/transfers/lib/control.ts) already
// dispatch to the worker by transferId, and a zip transfer registers in the same transferControls map
// sdk.worker.ts keys every transfer by — no zip-specific control wiring is needed here.
export interface RunZipDownloadDeps {
	downloadZip: (
		items: AnyItemWithContext[],
		transferId: string,
		save: SaveTarget,
		onProgress: (bytesWritten: bigint, totalBytes: bigint, itemsProcessed: bigint, totalItems: bigint) => void
	) => Promise<void>
	store: Pick<TransfersStore, "add" | "setProgress" | "setSize" | "settle" | "remove">
	// Optional, as RunDownloadDeps' own (download.ts): tells the user the download started.
	announceStart?: (name: string, count: number) => void
}

// One zip attempt: resolve where it saves to FIRST — a picker-cancel is a clean no-op (mirrors
// runDownload exactly: no transfer row is ever created for a cancelled picker) — then, on the fsa
// path, register ONE download-direction row for the whole batch and stream it through the injected
// `downloadZip` op with THROTTLED progress. The SDK's zip callback reports a running TOTAL across the
// whole archive (not per item), and that total itself grows as the recursive listing discovers more
// files, so both the row's size and its transferred bytes are driven off the same callback on every
// throttled tick, unlike a single-file download's already-known size fixed once at add(). `Cancelled`
// removes the row entirely (mobile parity, mirrors runDownload). Never throws; LABEL-FIRST via
// runOp/asErrorDTO.
export async function runZipDownload(
	deps: RunZipDownloadDeps,
	args: { items: DriveItem[]; suggestedName: string }
): Promise<VoidActionOutcome> {
	const { items, suggestedName } = args
	const id = crypto.randomUUID()

	let save: SaveTarget
	try {
		save = await saveDownload(suggestedName)
	} catch (e) {
		if (isPickerCancelled(e)) {
			return { status: "success" }
		}

		return { status: "error", dto: asErrorDTO(e) }
	}

	deps.store.add({
		id,
		direction: "download",
		name: suggestedName,
		size: 0,
		bytesTransferred: 0,
		status: "downloading",
		parentUuid: null,
		startedAt: Date.now(),
		...(save.kind === "sw" ? { browserManaged: true as const } : {})
	})
	deps.announceStart?.(suggestedName, items.length)

	const reportProgress = throttle((bytesWritten: bigint, totalBytes: bigint) => {
		deps.store.setSize(id, Number(totalBytes))
		deps.store.setProgress(id, Number(bytesWritten))
	}, PROGRESS_THROTTLE_MS)

	try {
		await runOp(deps.downloadZip(narrowToSdkItems(items), id, save, reportProgress))
	} catch (e) {
		const dto = asErrorDTO(e)

		return settleTransferFailure(deps.store, id, dto) ? { status: "success" } : { status: "error", dto }
	}

	// The SDK rejects the WHOLE call on any real per-entry failure (verified against filen-sdk-rs's
	// download_zip_items: a FuturesUnordered walk over every item bails on the first Err) — a resolve
	// here is unconditionally a complete zip, never a partial one, so this always settles "done", never
	// "completedWithErrors" — that status stays reserved for a partial-failure signal the SDK doesn't
	// actually expose at this boundary.
	deps.store.settle(id, "done")

	return { status: "success" }
}

function downloadZipViaFsa(
	items: AnyItemWithContext[],
	transferId: string,
	save: FsaSaveTarget,
	onProgress: (bytesWritten: bigint, totalBytes: bigint, itemsProcessed: bigint, totalItems: bigint) => void
): Promise<void> {
	return pipeWorkerToSink(save.writable, transferred =>
		sdkApi.downloadItemsToZip(items, transferId, transferred, Comlink.proxy(onProgress))
	)
}

// The real wiring behind RunZipDownloadDeps.downloadZip: fsa streams through the worker directly, sw
// registers the AnyItemWithContext[] with the service worker, lets a plain navigation hand the save to
// the browser's own download manager, and settles on the worker's report of it — mirrors download.ts's
// defaultDownloadDeps.download split exactly.
export const defaultZipDownloadDeps: RunZipDownloadDeps = {
	downloadZip: (items, transferId, save, onProgress) =>
		save.kind === "sw"
			? triggerSwZipDownload(items, save, transferId, (bytesWritten, totalBytes) => {
					onProgress(BigInt(bytesWritten), BigInt(totalBytes ?? 0), 0n, 0n)
				})
			: downloadZipViaFsa(items, transferId, save, onProgress),
	store: useTransfersStore.getState(),
	announceStart: toastDownloadStarted
}

// A single directory names the archive after itself; anything else (a multi-item selection, mixed
// files/dirs) has no one name to derive from, so it falls back to a generic archive name.
function resolveSuggestedZipName(items: DriveItem[]): string {
	const [item] = items

	if (items.length === 1 && item !== undefined && isDirectoryItem(item)) {
		return `${driveItemName(item)}.zip`
	}

	return i18n.t("transfers:transfersZipDownloadDefaultName")
}

// The zip-download seam startDownloads' needsZip branch (download.ts) routes into. Mirrors
// startDownloads' own summary-toast rationale: runZipDownload's return is the shared 2-state
// VoidActionOutcome, so a picker-cancel is indistinguishable from a real completed zip here too — this
// never claims success on the toast, the transfer row (the browser's download manager on the sw path)
// is already that signal.
export async function startZipDownload(items: DriveItem[]): Promise<void> {
	if (items.length === 0) {
		return
	}

	const outcome = await runZipDownload(defaultZipDownloadDeps, { items, suggestedName: resolveSuggestedZipName(items) })

	if (outcome.status === "error") {
		toast.error(i18n.t("transfers:transfersDownloadSummaryCompleteWithFailures", { count: 0, failed: 1 }))
	}
}
