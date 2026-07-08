import * as Comlink from "comlink"
import type { ZipItem } from "@filen/sdk-rs"
import { toast } from "sonner"
import { sdkApi } from "@/lib/sdk/client"
import { i18n } from "@/lib/i18n"
import { runOp, type VoidActionOutcome } from "@/lib/actions/outcome"
import { asErrorDTO } from "@/lib/sdk/errors"
import { asDirectoryOrFile, type DriveItem } from "@/lib/drive/item"
import { throttle, PROGRESS_THROTTLE_MS } from "@/lib/drive/upload"
import { saveDownload, isPickerCancelled, type SaveTarget, type FsaSaveTarget } from "@/lib/drive/save-download"
import { useTransfersStore, type TransfersStore } from "@/stores/transfers"

// Maps a selection to what downloadItemsToZip wants. A file narrows the same way narrowToAnyFile does
// (download.ts): asDirectoryOrFile(item).data is a structural superset, assignable with no adapter. A
// directory turns out to need no adapter either — @filen/sdk-rs's AnyDirWithContext =
// AnySharedDirWithContext | AnyLinkedDirWithContext | AnyNormalDir, and AnyNormalDir = Dir | Root, so a
// plain owned directory's flattened data (already a structural Dir superset) lands on the AnyNormalDir
// arm directly (confirmed against the Rust source: AnyDirWithContext is an untagged enum, and a bare
// Dir-shaped object fails the {dir,shareInfo}/{dir,link} wrapper shapes first, falling through to
// Normal). A shared directory flattens the exact same uniform way — asDirectoryOrFile normalizes every
// arm to the same Dir-shaped data — rather than reconstructing AnySharedDirWithContext's wrapper; this
// mirrors how a shared FILE already narrows through the single-file download path today, not a new gap
// this introduces, but it is unverified at runtime against an actually-shared directory (no login
// available in this environment — flagged for QA, same caliber as sdk.worker.ts's own held-item ops).
export function narrowToZipItems(items: DriveItem[]): ZipItem[] {
	return items.map(item => asDirectoryOrFile(item).data)
}

// DI mirror of RunDownloadDeps (download.ts) for the zip path — one archive, one transfer row, one
// save dialog. No `cancel` field: cancelTransfer/pauseTransfer (lib/transfers/control.ts) already
// dispatch to sdkApi.cancelDownload/pauseDownload by transferId for any "download"-direction row, and a
// zip transfer registers under the exact same downloadAborts/downloadPauses maps sdk.worker.ts already
// keys single-file downloads by — no zip-specific control wiring is needed here.
export interface RunZipDownloadDeps {
	downloadZip: (
		items: ZipItem[],
		transferId: string,
		save: SaveTarget,
		onProgress: (bytesWritten: bigint, totalBytes: bigint, itemsProcessed: bigint, totalItems: bigint) => void
	) => Promise<void>
	store: Pick<TransfersStore, "add" | "setProgress" | "setSize" | "settle" | "remove">
}

// One zip attempt: resolve where it saves to FIRST — a picker-cancel is a clean no-op (mirrors
// runDownload exactly: no transfer row is ever created for a cancelled picker) — then register ONE
// download-direction row for the whole batch and stream it through the injected `downloadZip` op with
// THROTTLED progress. The SDK's zip callback reports a running TOTAL across the whole archive (not per
// item), and that total itself grows as the recursive listing discovers more files, so both the row's
// size and its transferred bytes are driven off the same callback on every throttled tick, unlike a
// single-file download's already-known size fixed once at add(). `Cancelled` removes the row entirely
// (mobile parity, mirrors runDownload). Never throws; LABEL-FIRST via runOp/asErrorDTO.
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
		startedAt: Date.now()
	})

	const reportProgress = throttle((bytesWritten: bigint, totalBytes: bigint) => {
		deps.store.setSize(id, Number(totalBytes))
		deps.store.setProgress(id, Number(bytesWritten))
	}, PROGRESS_THROTTLE_MS)

	try {
		await runOp(deps.downloadZip(narrowToZipItems(items), id, save, reportProgress))
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

	// The SDK rejects the WHOLE call on any real per-entry failure (verified against filen-sdk-rs's
	// download_zip_items: a FuturesUnordered walk over every item bails on the first Err) — a resolve
	// here is unconditionally a complete zip, never a partial one, so this always settles "done", never
	// "completedWithErrors" — that status stays reserved for a partial-failure signal the SDK doesn't
	// actually expose at this boundary.
	deps.store.settle(id, "done")

	return { status: "success" }
}

// The FSA sink wiring — identical shape to download.ts's downloadViaFsa, same coordinated teardown: the
// worker call rejecting can leave the transferred writable open, so the pipe is aborted on the same
// shared signal rather than hanging forever on an abandoned stream.
async function downloadZipViaFsa(
	items: ZipItem[],
	transferId: string,
	save: FsaSaveTarget,
	onProgress: (bytesWritten: bigint, totalBytes: bigint, itemsProcessed: bigint, totalItems: bigint) => void
): Promise<void> {
	const transform = new TransformStream<Uint8Array, Uint8Array>()
	const teardown = new AbortController()
	const sinkDone = transform.readable.pipeTo(save.writable, { signal: teardown.signal }).catch(() => undefined)

	try {
		await sdkApi.downloadItemsToZip(
			items,
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

// The real wiring behind RunZipDownloadDeps.downloadZip. The sw branch is unreachable through any
// shipped entry point today — every dir/multi Download gate stays off unless isFsaAvailable() (see
// item-menu.logic.ts / bulk-action-bar.logic.ts / directory-listing.tsx) — but rejects with a clear
// error rather than silently misdownloading if it's ever reached before the service-worker zip path
// lands. Promise.reject, not a bare throw: this is typed as returning Promise<void>, so every caller
// (runZipDownload's try/catch, but also a bare `deps.downloadZip(...).catch(...)`) expects a rejection
// to arrive THROUGH the promise, never as a synchronous exception out of the call itself.
export const defaultZipDownloadDeps: RunZipDownloadDeps = {
	downloadZip: (items, transferId, save, onProgress) => {
		if (save.kind === "sw") {
			return Promise.reject(new Error("zip over service worker not supported yet"))
		}

		return downloadZipViaFsa(items, transferId, save, onProgress)
	},
	store: useTransfersStore.getState()
}

// A single directory names the archive after itself; anything else (a multi-item selection, mixed
// files/dirs) has no one name to derive from, so it falls back to a generic archive name.
function resolveSuggestedZipName(items: DriveItem[]): string {
	const [item] = items

	if (items.length === 1 && item !== undefined && asDirectoryOrFile(item).type === "directory") {
		return `${item.data.decryptedMeta?.name ?? item.data.uuid}.zip`
	}

	return i18n.t("transfers:transfersZipDownloadDefaultName")
}

// The zip-download seam startDownloads' needsZip branch (download.ts) routes into. Mirrors
// startDownloads' own summary-toast rationale: runZipDownload's return is the shared 2-state
// VoidActionOutcome, so a picker-cancel is indistinguishable from a real completed zip here too — this
// never claims success on the toast, the transfer row is already that signal.
export async function startZipDownload(items: DriveItem[]): Promise<void> {
	if (items.length === 0) {
		return
	}

	const outcome = await runZipDownload(defaultZipDownloadDeps, { items, suggestedName: resolveSuggestedZipName(items) })

	if (outcome.status === "error") {
		toast.error(i18n.t("transfers:transfersDownloadSummaryCompleteWithFailures", { count: 0, failed: 1 }))
	}
}
