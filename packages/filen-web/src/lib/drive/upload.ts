import * as Comlink from "comlink"
import type { File as SdkFile } from "@filen/sdk-rs"
import { toast } from "sonner"
import { sdkApi } from "@/lib/sdk/client"
import { i18n } from "@/lib/i18n"
import { runOp, type VoidActionOutcome } from "@/lib/actions/outcome"
import { asErrorDTO } from "@/lib/sdk/errors"
import { narrowItem, upsertDriveItem } from "@/lib/drive/item"
import { driveListingQueryUpdate } from "@/queries/drive"
import { useTransfersStore, type TransfersStore } from "@/features/transfers/store/useTransfersStore"

// Leading+trailing throttle, written locally rather than pulling a dependency — no throttle/debounce
// util exists in src/lib yet. The leading edge invokes immediately so the first progress
// notification never waits; every call arriving inside the window only overwrites a pending buffer,
// and exactly the LAST one fires at the trailing edge once the window elapses — critical for upload
// progress, whose final notification (100%) must never be the one a throttle silently drops. A call
// arriving once the window has fully elapsed (no pending buffer left over) starts a fresh cycle.
export function throttle<Args extends unknown[]>(fn: (...args: Args) => void, ms: number): (...args: Args) => void {
	let lastInvoked: number | null = null
	let timeoutId: ReturnType<typeof setTimeout> | null = null
	let pendingArgs: Args | null = null

	function invoke(args: Args): void {
		lastInvoked = Date.now()
		fn(...args)
	}

	return (...args: Args) => {
		const now = Date.now()

		if (lastInvoked === null || now - lastInvoked >= ms) {
			if (timeoutId !== null) {
				clearTimeout(timeoutId)
				timeoutId = null
			}
			pendingArgs = null
			invoke(args)
			return
		}

		pendingArgs = args

		if (timeoutId === null) {
			const remaining = ms - (now - lastInvoked)
			timeoutId = setTimeout(() => {
				timeoutId = null
				if (pendingArgs !== null) {
					const toSend = pendingArgs
					pendingArgs = null
					invoke(toSend)
				}
			}, remaining)
		}
	}
}

// ~10 store updates/sec per transfer is plenty for a progress bar and keeps a many-file batch from
// re-rendering the transfers panel on every chunk (mobile parity). Exported so lib/drive/download.ts
// reuses the exact same cadence instead of redeclaring the constant.
export const PROGRESS_THROTTLE_MS = 100

// Injected collaborators so a single upload attempt is unit-testable without a worker or a query
// client — mirrors runCreateDirectory's shape (lib/drive/create-directory.ts). `store` needs `remove`
// too now: a Cancelled rejection drops the row entirely (mirrors runDownload). `cancel` is unused by
// runUpload itself, same as RunDownloadDeps' own (download.ts) — kept for DI/testability parity.
export interface RunUploadDeps {
	upload: (parentUuid: string | null, transferId: string, file: File, onProgress: (bytes: bigint) => void) => Promise<SdkFile>
	cancel?: (transferId: string) => void
	store: Pick<TransfersStore, "add" | "setProgress" | "settle" | "remove">
	patchListing: typeof driveListingQueryUpdate
}

// One upload attempt: register it in the transfers store, stream it through the injected `upload` op
// with THROTTLED progress (the raw callback fires per chunk — see sdk.worker.ts's own uploadFile op —
// far more often than any UI needs to re-render), then settle the store and — only on success — patch
// the destination listing so the new file appears without a refetch. `Cancelled` (the SDK's abort
// rejection kind — see sdk.worker.ts's uploadFile) removes the row entirely rather than leaving a
// finished entry behind (mobile parity: an aborted transfer has no history). Never throws; LABEL-FIRST
// via runOp/asErrorDTO, mirroring every VoidActionOutcome helper in lib/drive/actions.ts and
// lib/contacts/actions.ts.
export async function runUpload(deps: RunUploadDeps, args: { parentUuid: string | null; file: File }): Promise<VoidActionOutcome> {
	const { parentUuid, file } = args
	const id = crypto.randomUUID()

	deps.store.add({
		id,
		direction: "upload",
		name: file.name,
		size: file.size,
		bytesTransferred: 0,
		status: "uploading",
		parentUuid,
		startedAt: Date.now()
	})

	const reportProgress = throttle((bytes: bigint) => {
		// A file's byte size is always well under 2^53 — safe to narrow the cumulative bigint into a
		// plain number for the store (never put a bigint itself in React state or a query key).
		deps.store.setProgress(id, Number(bytes))
	}, PROGRESS_THROTTLE_MS)

	let uploaded: SdkFile
	try {
		uploaded = await runOp(deps.upload(parentUuid, id, file, reportProgress))
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
	deps.patchListing(parentUuid, prev => upsertDriveItem(prev, narrowItem(uploaded)))

	return { status: "success" }
}

// The real wiring behind RunUploadDeps.upload: crosses to the sdk worker, with `onProgress` wrapped
// in Comlink.proxy — a plain function can't structured-clone across the worker boundary, so it must
// be marked for Comlink to re-wrap it worker-side into a callable (mirrors lib/drive/actions.ts's
// createLink, which proxies createDirectoryLink's own re-encrypt progress callback the same way).
// `cancel` mirrors defaultDownloadDeps.cancel (download.ts): fire-and-forget straight to the worker,
// unused by runUpload itself. `useTransfersStore.getState()` grabs the store's ACTIONS once — they're
// stable references for the store's entire lifetime (zustand never reassigns them), so reading them
// here at module scope is safe as non-render orchestration code, unlike reading state itself outside
// a selector hook. Exported so upload-directory.ts's own defaultDirectoryUploadDeps can reuse this
// exact wiring (including the Comlink.proxy wrap) for its per-file uploads instead of re-declaring it.
export const defaultUploadDeps: RunUploadDeps = {
	upload: (parentUuid, id, file, onProgress) => sdkApi.uploadFile(parentUuid, id, file, Comlink.proxy(onProgress)),
	cancel: id => {
		void sdkApi.cancelUpload(id)
	},
	store: useTransfersStore.getState(),
	patchListing: driveListingQueryUpdate
}

// Fan out every file in parallel — no JS queue/semaphore: the SDK's own Tower layer throttles actual
// upload concurrency (CLAUDE.md rule: never reimplement concurrency/retry limits in JS). Each file is
// fully independent (its own transfer row, its own outcome), so one failing upload never blocks or
// cancels the rest. Ends in one SUMMARY toast — toastBulkOutcome (lib/drive/bulk-toast.ts) is typed
// specifically to BulkOutcome<DriveItem>, which a raw File fan-out never produces, so this counts the
// runUpload outcomes directly instead of forcing a mismatched reuse.
export async function startUploads(files: File[], parentUuid: string | null): Promise<void> {
	if (files.length === 0) {
		return
	}

	const outcomes = await Promise.all(files.map(file => runUpload(defaultUploadDeps, { parentUuid, file })))
	const succeeded = outcomes.filter(outcome => outcome.status === "success").length
	const failed = outcomes.length - succeeded

	if (failed === 0) {
		toast.success(i18n.t("transfers:transfersUploadSummaryComplete", { count: succeeded }))
		return
	}

	toast.error(i18n.t("transfers:transfersUploadSummaryCompleteWithFailures", { count: succeeded, failed }))
}
