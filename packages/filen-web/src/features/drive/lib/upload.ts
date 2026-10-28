import type { File as SdkFile } from "@filen/sdk-rs"
import { hashKey } from "@tanstack/react-query"
import { sumBytes } from "@filen/shared"
import { sdkApi } from "@/lib/sdk/client"
import { runOp, type VoidActionOutcome } from "@/lib/actions/outcome"
import { toastSummary } from "@/lib/actions/bulkToast"
import { toastTransferStarted } from "@/features/transfers/lib/transferStartToast"
import { openProgressChannel } from "@/features/transfers/lib/progressChannel"
import { asErrorDTO, type ErrorDTO } from "@/lib/sdk/errors"
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
import {
	useTransfersStore,
	type Transfer,
	type TransfersStore,
	type UploadBatchRef,
	type UploadBatchTotals
} from "@/features/transfers/store/useTransfersStore"
import { settleTransferFailure } from "@/features/transfers/lib/settle"
import {
	defaultHeicUploadDeps,
	heicUploadConversionEnabled,
	isHeicUploadCandidate,
	maybeConvertHeicUpload
} from "@/features/drive/lib/heicUpload"
import { warmUploadThumbnail } from "@/features/drive/lib/thumbGenerators"
import { addAccountStorageUsed, ensureUploadQuota } from "@/features/drive/lib/quota"

// Injected collaborators so a single upload attempt is unit-testable without a worker or a query
// client — mirrors runCreateDirectory's shape (features/drive/lib/createDirectory.ts). `store` needs `remove`
// too now: a Cancelled rejection drops the row entirely (mirrors runDownload). `cancel` is unused by
// runUpload itself, same as RunDownloadDeps' own (download.ts) — kept for DI/testability parity. Progress
// reaches the store on its own, through the worker's one progress channel (progressChannel.ts); `runId`
// names the directory run whose stop and pause the file shares.
export interface RunUploadDeps {
	upload: (parentUuid: string | null, transferId: string, file: File, runId?: string) => Promise<SdkFile>
	cancel?: (transferId: string) => void
	store: Pick<TransfersStore, "add" | "settle" | "setItem" | "remove" | "startRunFile" | "settleRunFile">
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

// A plain upload's row, as runUpload adds it; startUploads adds a whole selection's in one write.
export function uploadRow(file: File, parentUuid: string | null, batch: UploadBatchRef | undefined): Omit<Transfer, "paused"> {
	return {
		id: crypto.randomUUID(),
		direction: "upload",
		name: file.name,
		size: file.size,
		bytesTransferred: 0,
		status: "uploading",
		parentUuid,
		startedAt: Date.now(),
		...(batch !== undefined ? { batch } : {})
	}
}

// One upload attempt: register it in the transfers store, stream it through the injected `upload` op (its
// progress reaches the store through the worker's progress channel), then settle the store and — only on
// success — patch the destination listing so the new file appears without a refetch. `Cancelled` (the
// SDK's abort rejection kind — see sdk.worker.ts's uploadFile) removes the row entirely rather than
// leaving a finished entry behind (mobile parity: an aborted transfer has no history). Never throws;
// LABEL-FIRST via runOp/asErrorDTO, mirroring every VoidActionOutcome helper in
// features/drive/lib/actions.ts and features/contacts/lib/actions.ts, plus a "cancelled" arm so a summary
// never counts a cancelled file as uploaded.
// A file of a directory run gets no row: it moves its run's, and only a failure leaves one of its own,
// named `name` (its path in the picked tree). `counted` is the size its run was sized with for it; `row`
// is a row startUploads already added.
export async function runUpload(
	deps: RunUploadDeps,
	args: {
		parentUuid: string | null
		file: File
		batch?: UploadBatchRef | undefined
		counted?: number
		name?: string
		row?: Omit<Transfer, "paused">
	}
): Promise<UploadOutcome> {
	const { parentUuid, file, batch } = args

	if (batch?.directoryName !== undefined) {
		return runRunFileUpload(deps, { ...args, batch })
	}

	const row = args.row ?? uploadRow(file, parentUuid, batch)
	const { id } = row

	if (args.row === undefined) {
		deps.store.add(row, args.counted)
	}

	let uploaded: SdkFile
	try {
		uploaded = await runOp(deps.upload(parentUuid, id, file))
	} catch (e) {
		const dto = asErrorDTO(e)

		return settleTransferFailure(deps.store, id, dto) ? { status: "cancelled" } : { status: "error", dto }
	}

	deps.store.settle(id, "done")
	deps.store.setItem(id, narrowItem(uploaded))
	landUpload(deps, parentUuid, file, uploaded)

	return { status: "success" }
}

async function runRunFileUpload(
	deps: RunUploadDeps,
	args: { parentUuid: string | null; file: File; batch: UploadBatchRef; counted?: number; name?: string }
): Promise<UploadOutcome> {
	const { parentUuid, file, batch } = args
	const id = crypto.randomUUID()

	deps.store.startRunFile({ id, batchId: batch.id, size: file.size, ...(args.counted === undefined ? {} : { counted: args.counted }) })

	let uploaded: SdkFile
	try {
		uploaded = await runOp(deps.upload(parentUuid, id, file, batch.id))
	} catch (e) {
		const dto = asErrorDTO(e)

		if (dto.kind === "Cancelled") {
			deps.store.settleRunFile(id, "cancelled")

			return { status: "cancelled" }
		}

		deps.store.settleRunFile(id, "error", dto, { name: args.name ?? file.name, parentUuid })

		return { status: "error", dto }
	}

	deps.store.settleRunFile(id, "done")
	landUpload(deps, parentUuid, file, uploaded)

	return { status: "success" }
}

function landUpload(deps: RunUploadDeps, parentUuid: string | null, file: File, uploaded: SdkFile): void {
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

	// Only sizes something cached: a directory the batch created that no listing showed has none.
	const queryCache = queryClient.getQueryCache()

	for (const uuid of targets) {
		if (queryCache.get(hashKey(directorySizeQueryKey(uuid))) === undefined) {
			targets.delete(uuid)
		}
	}

	if (targets.size === 0) {
		return
	}

	const displayed = new Set<string>()

	for (const query of cachedQueriesWithPrefix(DRIVE_LISTING_KEY_PREFIX).filter(query => query.isActive())) {
		for (const item of queryClient.getQueryData<DriveItem[]>(query.queryKey) ?? []) {
			if (targets.delete(item.data.uuid)) {
				displayed.add(item.data.uuid)
			}
		}
	}

	// One pass over the query cache per refetch type, however many directories the batch touched.
	for (const [uuids, refetchType] of [
		[displayed, "all"],
		[targets, "active"]
	] as const) {
		if (uuids.size > 0) {
			void queryClient.invalidateQueries({ predicate: query => isDirectorySizeKeyIn(query.queryKey, uuids), refetchType })
		}
	}
}

function isDirectorySizeKeyIn(queryKey: readonly unknown[], uuids: ReadonlySet<string>): boolean {
	const [scope, kind] = directorySizeQueryKey("")
	const uuid = queryKey[2]

	return queryKey[0] === scope && queryKey[1] === kind && typeof uuid === "string" && uuids.has(uuid)
}

// The real wiring behind RunUploadDeps.upload: crosses to the sdk worker, its progress coming back through
// the worker's one progress channel (opened ahead of the op, see progressChannel.ts).
// `cancel` mirrors defaultDownloadDeps.cancel (download.ts): fire-and-forget straight to the worker,
// unused by runUpload itself. `useTransfersStore.getState()` grabs the store's ACTIONS once — they're
// stable references for the store's entire lifetime (zustand never reassigns them), so reading them
// here at module scope is safe as non-render orchestration code, unlike reading state itself outside
// a selector hook. Exported so uploadDirectory.ts's own defaultDirectoryUploadDeps can reuse this
// exact wiring for its per-file uploads instead of re-declaring it.
export const defaultUploadDeps: RunUploadDeps = {
	upload: (parentUuid, id, file, runId) => {
		openProgressChannel()

		return sdkApi.uploadFile(parentUuid, id, file, runId)
	},
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
	// Sized at `totals` from the start, so its row shows the whole size and time left at once. A directory
	// run started `scanning` is sized again once its walk is done.
	start: (ref: UploadBatchRef, totals: UploadBatchTotals, options?: { scanning: boolean }) => void
	isCancelled: (id: string) => boolean
	// `skippedBytes`: the size of the files among the items, which the run was sized with.
	fail: (id: string, count: number, error?: ErrorDTO, skippedBytes?: number) => void
	// A directory run's top-level directory exists: its row's "Show in directory" opens it.
	created: (id: string, item: DriveItem) => void
	end: (id: string) => void
}

export const uploadBatchControl: UploadBatchControl = {
	start: (ref, totals, options) => {
		const fresh = useTransfersStore.getState().uploadBatches[ref.id] === undefined

		useTransfersStore.getState().startUploadBatch(ref, totals, options)

		// Ahead of any file of it, so a pause or stop made meanwhile holds for all of them.
		if (fresh && ref.directoryName !== undefined) {
			void sdkApi.openTransferRun(ref.id)
		}
	},
	isCancelled: id => useTransfersStore.getState().uploadBatches[id]?.cancelled === true,
	fail: (id, count, error, skippedBytes) => {
		useTransfersStore.getState().failUploadBatchItems(id, count, error, skippedBytes)
	},
	created: (id, item) => {
		useTransfersStore.getState().setItem(id, item)
	},
	end: id => {
		const directoryRun = useTransfersStore.getState().uploadBatches[id]?.ref.directoryName !== undefined

		useTransfersStore.getState().endUploadBatch(id)

		if (directoryRun) {
			void sdkApi.releaseJob(id)
		}
	}
}

// Runs that never got to upload, their walk failed or the quota blocked them: they leave with their rows.
export function discardUploadRuns(ids: ReadonlySet<string>): void {
	if (ids.size === 0) {
		return
	}

	useTransfersStore.getState().discardUploadBatches(ids)

	for (const id of ids) {
		void sdkApi.releaseJob(id)
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
// cancels the rest. The rows of the files that need no conversion land in one store write. Ends in one
// summary toast.
export async function startUploads(files: File[], parentUuid: string | null): Promise<void> {
	if (files.length === 0) {
		return
	}

	const bytes = sumBytes(files.map(file => file.size))

	// The whole selection or nothing: a partial start would leave an arbitrary subset uploaded. Sized
	// before HEIC conversion, so the server stays the judge of a near-exact fit.
	if (!(await ensureUploadQuota(bytes))) {
		return
	}

	const convertHeic = await heicUploadConversionEnabled(defaultHeicUploadDeps, files)
	const batch = newUploadBatchRef(parentUuid)

	uploadBatchControl.start(batch, { files: files.length, bytes: Number(bytes) })
	toastTransferStarted({ direction: "upload", name: files[0]?.name ?? "", count: files.length, noun: "files" })

	const rows = files.map(file => (convertHeic && isHeicUploadCandidate(file) ? undefined : uploadRow(file, parentUuid, batch)))

	useTransfersStore.getState().addMany(rows.filter(row => row !== undefined))

	const outcomes = await Promise.all(
		files.map(async (file, index): Promise<UploadOutcome> => {
			const row = rows[index]

			if (row !== undefined) {
				return await runUpload(defaultUploadDeps, { parentUuid, file, batch, row })
			}

			const prepared = await maybeConvertHeicUpload(defaultHeicUploadDeps.convert, file, convertHeic)

			// Cancelled from the listing while this one was still being prepared.
			if (uploadBatchControl.isCancelled(batch.id)) {
				return { status: "cancelled" }
			}

			return await runUpload(defaultUploadDeps, { parentUuid, file: prepared, batch, counted: file.size })
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
