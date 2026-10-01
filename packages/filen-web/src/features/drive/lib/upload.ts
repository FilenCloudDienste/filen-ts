import * as Comlink from "comlink"
import type { File as SdkFile } from "@filen/sdk-rs"
import { sumBytes } from "@filen/shared"
import { sdkApi } from "@/lib/sdk/client"
import { runOp, type VoidActionOutcome } from "@/lib/actions/outcome"
import { toastSummary } from "@/lib/actions/bulkToast"
import { asErrorDTO, type ErrorDTO } from "@/lib/sdk/errors"
import { throttle, PROGRESS_THROTTLE_MS } from "@/lib/throttle"
import { queryClient } from "@/queries/client"
import { cachedQueriesWithPrefix } from "@/queries/patch"
import { asDirectoryOrFile, narrowItem, type DriveItem } from "@/features/drive/lib/item"
import {
	DRIVE_LISTING_KEY_PREFIX,
	directorySizeQueryKey,
	findCachedListingItem,
	normalizeParentUuid,
	queueListingCreate
} from "@/features/drive/queries/drive"
import { accountQueryGet, markAccountStale } from "@/queries/account"
import { useTransfersStore, type TransfersStore, type UploadBatchRef } from "@/features/transfers/store/useTransfersStore"
import { settleTransferFailure } from "@/features/transfers/lib/settle"
import { defaultHeicUploadDeps, heicUploadConversionEnabled, maybeConvertHeicUpload } from "@/features/drive/lib/heicUpload"
import { warmUploadThumbnail } from "@/features/drive/lib/thumbGenerators"
import { addAccountStorageUsed, ensureUploadQuota } from "@/features/drive/lib/quota"

// Injected collaborators so a single upload attempt is unit-testable without a worker or a query
// client — mirrors runCreateDirectory's shape (features/drive/lib/createDirectory.ts). `store` needs `remove`
// too now: a Cancelled rejection drops the row entirely (mirrors runDownload). `cancel` is unused by
// runUpload itself, same as RunDownloadDeps' own (download.ts) — kept for DI/testability parity.
export interface RunUploadDeps {
	upload: (parentUuid: string | null, transferId: string, file: File, onProgress: (bytes: bigint) => void) => Promise<SdkFile>
	cancel?: (transferId: string) => void
	store: Pick<TransfersStore, "add" | "setProgress" | "settle" | "setItem" | "remove">
	// Splices the landed file into its parent listing (queueListingCreate: batched with the other
	// creates, its own socket echo included).
	patchCreated: (parentUuid: string | null, item: DriveItem) => void
	// Optional (mirrors `cancel` above), and like `cancel` unused by runUpload itself: the batch callers
	// (startUploads, runDirectoryUpload) invoke it once after their whole fan-out rather than once per
	// file, see invalidateUploadedDirectorySizes. Tests that don't care about sizes simply omit it.
	invalidateDirectorySizes?: typeof invalidateUploadedDirectorySizes
	// Optional for the same DI reason: the account's storage used moved (see queries/account.ts's
	// markAccountStale).
	markAccountStale?: () => void
	// Optional for the same DI reason: the cached storage used, bumped so the next quota pre-flight
	// counts this upload (see quota.ts's addAccountStorageUsed).
	addStorageUsed?: (bytes: bigint) => void
	// Optional for the same DI reason: turns the bytes still in hand into this file's
	// thumbnail instead of letting the listing download them straight back. Synchronous and
	// fire-and-forget by contract — see warmUploadThumbnail (thumbGenerators.ts) for why.
	warmThumbnail?: (uploaded: SdkFile, file: File) => void
}

export type UploadOutcome = VoidActionOutcome | { status: "cancelled" }

// One upload attempt: register it in the transfers store, stream it through the injected `upload` op
// with THROTTLED progress (the raw callback fires per chunk — see sdk.worker.ts's own uploadFile op —
// far more often than any UI needs to re-render), then settle the store and — only on success — patch
// the destination listing so the new file appears without a refetch. `Cancelled` (the SDK's abort
// rejection kind — see sdk.worker.ts's uploadFile) removes the row entirely rather than leaving a
// finished entry behind (mobile parity: an aborted transfer has no history). Never throws; LABEL-FIRST
// via runOp/asErrorDTO, mirroring every VoidActionOutcome helper in features/drive/lib/actions.ts and
// features/contacts/lib/actions.ts, plus a "cancelled" arm so a summary never counts a cancelled file
// as uploaded.
export async function runUpload(
	deps: RunUploadDeps,
	args: { parentUuid: string | null; file: File; batch?: UploadBatchRef | undefined }
): Promise<UploadOutcome> {
	const { parentUuid, file, batch } = args
	const id = crypto.randomUUID()

	deps.store.add({
		id,
		direction: "upload",
		name: file.name,
		size: file.size,
		bytesTransferred: 0,
		status: "uploading",
		parentUuid,
		startedAt: Date.now(),
		...(batch !== undefined ? { batch } : {})
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

		return settleTransferFailure(deps.store, id, dto) ? { status: "cancelled" } : { status: "error", dto }
	}

	deps.store.settle(id, "done")
	deps.store.setItem(id, narrowItem(uploaded))
	// BEFORE the listing patch, and that ordering is the whole point: patching the row in makes its
	// tile ask for a thumbnail on the very next commit, so the warm has to have claimed the uuid by
	// then or the tile starts downloading the file this upload just sent. Sequenced after the upload
	// itself resolved (never overlapped with it) — both read the same browser File, and while
	// Blob.stream() does hand out a fresh reader per call, there is no reason to have the SDK read the
	// same local file twice at once.
	deps.warmThumbnail?.(uploaded, file)
	deps.patchCreated(parentUuid, narrowItem(uploaded))
	deps.markAccountStale?.()
	deps.addStorageUsed?.(uploaded.size)

	return { status: "success" }
}

// Marks every cached recursive size an upload batch moved: the target directory, each ancestor a cached
// listing can name (walked through the listing cache, no request), and every directory the batch
// created (all descendants of the target, so they need no walk of their own). dirSize entries have no
// observers (useDriveDirectorySizes prefetches), so a plain invalidation only marks them stale; one that
// is a row of a listing on screen is refetched at once instead, or that row keeps its pre-upload size
// (for a directory the batch created, the near-empty size prefetched the moment it was patched in).
// The rest refetch when a listing showing them next mounts.
export function invalidateUploadedDirectorySizes(parentUuid: string | null, createdDirectoryUuids: readonly string[] = []): void {
	const targets = new Set<string>(createdDirectoryUuids)

	for (let uuid = parentUuid; uuid !== null && !targets.has(uuid);) {
		targets.add(uuid)

		const item = findCachedListingItem(uuid)

		uuid = item === undefined ? null : asDirectoryOrFile(item).data.parent
	}

	if (targets.size === 0) {
		return
	}

	const displayed = new Set<string>()

	for (const query of cachedQueriesWithPrefix(DRIVE_LISTING_KEY_PREFIX).filter(query => query.isActive())) {
		for (const item of queryClient.getQueryData<DriveItem[]>(query.queryKey) ?? []) {
			if (targets.has(item.data.uuid)) {
				displayed.add(item.data.uuid)
			}
		}
	}

	for (const uuid of targets) {
		void queryClient.invalidateQueries({ queryKey: directorySizeQueryKey(uuid), refetchType: displayed.has(uuid) ? "all" : "active" })
	}
}

// The real wiring behind RunUploadDeps.upload: crosses to the sdk worker, with `onProgress` wrapped
// in Comlink.proxy — a plain function can't structured-clone across the worker boundary, so it must
// be marked for Comlink to re-wrap it worker-side into a callable (mirrors features/drive/lib/actions.ts's
// createLink, which proxies createDirectoryLink's own re-encrypt progress callback the same way).
// `cancel` mirrors defaultDownloadDeps.cancel (download.ts): fire-and-forget straight to the worker,
// unused by runUpload itself. `useTransfersStore.getState()` grabs the store's ACTIONS once — they're
// stable references for the store's entire lifetime (zustand never reassigns them), so reading them
// here at module scope is safe as non-render orchestration code, unlike reading state itself outside
// a selector hook. Exported so uploadDirectory.ts's own defaultDirectoryUploadDeps can reuse this
// exact wiring (including the Comlink.proxy wrap) for its per-file uploads instead of re-declaring it.
export const defaultUploadDeps: RunUploadDeps = {
	upload: (parentUuid, id, file, onProgress) => sdkApi.uploadFile(parentUuid, id, file, Comlink.proxy(onProgress)),
	cancel: id => {
		void sdkApi.cancelTransfer(id)
	},
	store: useTransfersStore.getState(),
	patchCreated: queueListingCreate,
	invalidateDirectorySizes: invalidateUploadedDirectorySizes,
	markAccountStale,
	addStorageUsed: addAccountStorageUsed,
	warmThumbnail: warmUploadThumbnail
}

// The run side of the transfers store's upload runs (UploadBatch), which the target directory's listing
// shows while they run. Injected into the directory upload; plain uploads use it directly.
export interface UploadBatchControl {
	start: (ref: UploadBatchRef) => void
	isCancelled: (id: string) => boolean
	fail: (id: string, count: number, error?: ErrorDTO) => void
	end: (id: string) => void
}

export const uploadBatchControl: UploadBatchControl = {
	start: ref => {
		useTransfersStore.getState().startUploadBatch(ref)
	},
	isCancelled: id => useTransfersStore.getState().uploadBatches[id]?.cancelled === true,
	fail: (id, count, error) => {
		useTransfersStore.getState().failUploadBatchItems(id, count, error)
	},
	end: id => {
		useTransfersStore.getState().endUploadBatch(id)
	}
}

// A new run into `parentUuid`. Keyed to the listing that shows it, which names the root null: a drop on
// the sidebar's root names it by uuid.
export function newUploadBatchRef(parentUuid: string | null, directoryName?: string): UploadBatchRef {
	const listingParentUuid = normalizeParentUuid(parentUuid, accountQueryGet()?.rootDirUuid ?? "")

	return {
		id: crypto.randomUUID(),
		parentUuid: listingParentUuid,
		...(directoryName !== undefined ? { directoryName } : {})
	}
}

// Fan out every file in parallel — no JS queue/semaphore: the SDK's own Tower layer throttles actual
// upload concurrency (CLAUDE.md rule: never reimplement concurrency/retry limits in JS). Each file is
// fully independent (its own transfer row, its own outcome), so one failing upload never blocks or
// cancels the rest. Ends in one summary toast.
export async function startUploads(files: File[], parentUuid: string | null): Promise<void> {
	if (files.length === 0) {
		return
	}

	// The whole selection or nothing: a partial start would leave an arbitrary subset uploaded. Sized
	// before HEIC conversion, so the server stays the judge of a near-exact fit.
	if (!(await ensureUploadQuota(sumBytes(files.map(file => file.size))))) {
		return
	}

	const convertHeic = await heicUploadConversionEnabled(defaultHeicUploadDeps, files)
	const batch = newUploadBatchRef(parentUuid)

	uploadBatchControl.start(batch)

	const outcomes = await Promise.all(
		files.map(async (file): Promise<UploadOutcome> => {
			const prepared = await maybeConvertHeicUpload(defaultHeicUploadDeps.convert, file, convertHeic)

			// Cancelled from the listing while this one was still being prepared.
			if (uploadBatchControl.isCancelled(batch.id)) {
				return { status: "cancelled" }
			}

			return await runUpload(defaultUploadDeps, { parentUuid, file: prepared, batch })
		})
	)

	uploadBatchControl.end(batch.id)
	const succeeded = outcomes.filter(outcome => outcome.status === "success").length
	const failed = outcomes.filter(outcome => outcome.status === "error").length

	if (succeeded > 0) {
		defaultUploadDeps.invalidateDirectorySizes?.(parentUuid)
	}

	toastSummary(succeeded, failed, {
		complete: "transfers:transfersUploadSummaryComplete",
		withFailures: "transfers:transfersUploadSummaryCompleteWithFailures"
	})
}
