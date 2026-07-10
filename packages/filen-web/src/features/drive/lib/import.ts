import * as Comlink from "comlink"
import type { AnyFile, AnyDirWithContext, DirsAndFilesWithPaths } from "@filen/sdk-rs"
import { sdkApi } from "@/lib/sdk/client"
import { i18n } from "@/lib/i18n"
import { runOp, type VoidActionOutcome } from "@/lib/actions/outcome"
import { asErrorDTO, type ErrorDTO } from "@/lib/sdk/errors"
import { toAnyDirWithContext, type DriveItem } from "@/features/drive/lib/item"
import { narrowToAnyFile } from "@/features/drive/lib/download"
import { throttle, PROGRESS_THROTTLE_MS, runUpload, defaultUploadDeps, type RunUploadDeps } from "@/features/drive/lib/upload"
import { dirnameOf, basenameOf, depthOf } from "@/features/drive/lib/uploadDirectory"
import { runCreateDirectory, type CreateDirectoryDeps } from "@/features/drive/lib/createDirectory"
import { driveListingQueryUpdate } from "@/features/drive/queries/drive"
import { runBulk, type BulkOutcome } from "@/features/drive/lib/bulk"
import { useTransfersStore, type TransfersStore } from "@/features/transfers/store/useTransfersStore"

// Import a sharedIn item (owned by someone else) into your own drive — mobile parity: the SDK has no
// server-side copy op (see sdk.worker.ts's own listDirectoryRecursiveForImport comment), so mobile's
// Download > Import stages the item to a local tmp directory, then re-uploads it from there
// (menuActionsDownload.ts). The browser has no writable local staging directory reachable without a
// user-gesture save picker, so this stages IN MEMORY instead: one file's bytes at a time, immediately
// hand off to a real upload. Both legs route through the SAME worker ops and transfers-store rows a
// plain download/upload would (downloadFileToWriter/uploadFileFromReader, "download"/"upload"
// direction rows) — features/transfers/lib/control.ts's cancel/pause dispatch by transferId+direction
// reaches an import's rows unchanged.

// ── In-memory download sink ──────────────────────────────────────────────

// Collects a download's chunks into memory rather than piping them to disk/FSA — the WritableStream
// itself is transferred to the worker exactly like download.ts's downloadViaFsa transfers a
// TransformStream's writable half; only the sink differs.
function collectingSink(): { writable: WritableStream<Uint8Array>; blob: Promise<Blob> } {
	const chunks: Uint8Array[] = []
	let settle: (blob: Blob) => void = () => undefined
	const blob = new Promise<Blob>(resolve => {
		settle = resolve
	})

	const writable = new WritableStream<Uint8Array>({
		write(chunk) {
			chunks.push(chunk)
		},
		close() {
			// Same lib-dom BlobPart typing gap as thumbnails.ts/imageViewer.tsx's own Uint8Array->Blob
			// construction — a WritableStream<Uint8Array>'s chunks type as Uint8Array<ArrayBufferLike>,
			// BlobPart wants <ArrayBuffer>.
			settle(new Blob(chunks as BlobPart[]))
		}
	})

	return { writable, blob }
}

// DI mirror of RunDownloadDeps (download.ts) — same shape, an in-memory writable stands in for a
// SaveTarget.
export interface RunImportDownloadDeps {
	download: (
		file: AnyFile,
		transferId: string,
		writable: WritableStream<Uint8Array>,
		onProgress: (bytes: bigint) => void
	) => Promise<void>
	store: Pick<TransfersStore, "add" | "setProgress" | "settle" | "remove">
}

type ImportDownloadOutcome = { status: "success"; blob: Blob } | { status: "cancelled" } | { status: "error"; dto: ErrorDTO }

// Download leg: identical bookkeeping to runDownload (store row, throttled progress, LABEL-FIRST
// error, "Cancelled" handled distinctly so the caller can drop the whole import silently rather than
// toasting a failure) — only the sink is different.
async function runImportDownload(
	deps: RunImportDownloadDeps,
	args: { file: AnyFile; name: string; size: number }
): Promise<ImportDownloadOutcome> {
	const { file, name, size } = args
	const id = crypto.randomUUID()
	const { writable, blob } = collectingSink()

	deps.store.add({
		id,
		direction: "download",
		name,
		size,
		bytesTransferred: 0,
		status: "downloading",
		parentUuid: null,
		startedAt: Date.now()
	})

	const reportProgress = throttle((bytes: bigint) => {
		deps.store.setProgress(id, Number(bytes))
	}, PROGRESS_THROTTLE_MS)

	try {
		await runOp(deps.download(file, id, writable, reportProgress))
	} catch (e) {
		const dto = asErrorDTO(e)

		if (dto.kind === "Cancelled") {
			deps.store.settle(id, "cancelled")
			deps.store.remove(id)

			return { status: "cancelled" }
		}

		deps.store.settle(id, "error", dto)

		return { status: "error", dto }
	}

	deps.store.settle(id, "done")

	return { status: "success", blob: await blob }
}

async function downloadToMemory(
	file: AnyFile,
	transferId: string,
	writable: WritableStream<Uint8Array>,
	onProgress: (bytes: bigint) => void
): Promise<void> {
	await sdkApi.downloadFileToWriter(file, transferId, Comlink.transfer(writable, [writable]), Comlink.proxy(onProgress))
}

export const defaultImportDownloadDeps: RunImportDownloadDeps = {
	download: downloadToMemory,
	store: useTransfersStore.getState()
}

// ── One file: download into memory, then a real upload ──────────────────

export interface RunImportFileDeps {
	download: RunImportDownloadDeps
	upload: RunUploadDeps
}

// Unlike VoidActionOutcome, a cancelled download is reported as its OWN status rather than folded
// into "success" — runImportFile has two callers (runImportDirectory's file loop, importItem) that
// each need to compensate differently (skip vs. drop-silently), so the distinction can't be erased
// here the way runDownload/runUpload erase it for their own single-op callers.
export type ImportFileOutcome = { status: "success" } | { status: "cancelled" } | { status: "error"; dto: ErrorDTO }

// A cancelled download drops the whole import with no upload attempt (mirrors runDownload's own
// cancel-is-not-a-failure convention) — the upload leg is runUpload UNCHANGED, so a completed
// import's upload row is indistinguishable in the transfers panel from one picked off local disk.
export async function runImportFile(
	deps: RunImportFileDeps,
	args: { file: AnyFile; name: string; size: number; mime?: string; parentUuid: string | null }
): Promise<ImportFileOutcome> {
	const { file, name, size, mime, parentUuid } = args
	const downloadOutcome = await runImportDownload(deps.download, { file, name, size })

	if (downloadOutcome.status === "cancelled") {
		return { status: "cancelled" }
	}

	if (downloadOutcome.status === "error") {
		return { status: "error", dto: downloadOutcome.dto }
	}

	const browserFile = new File([downloadOutcome.blob], name, mime ? { type: mime } : {})

	return runUpload(deps.upload, { parentUuid, file: browserFile })
}

// ── One directory: recreate the tree, then import every nested file ─────

export interface RunImportDirectoryDeps {
	createDirectory: CreateDirectoryDeps
	importFile: RunImportFileDeps
	// Injected (mirrors every other DI seam here) rather than calling sdkApi directly, so this whole
	// function is testable with plain fakes — no worker/query-client mock boundary needed.
	listRecursive: (dir: AnyDirWithContext) => Promise<{ listing: DirsAndFilesWithPaths; hadScanErrors: boolean }>
}

// Recreates the imported directory's OWN top-level entry at the destination (mobile parity — the
// staged tmp directory mobile downloads into is named after the item, so the reupload lands a real
// new top-level directory, not just its contents), then its sub-tree parent-before-child (mirrors
// uploadDirectory.ts's runDirectoryUpload), downloading+re-uploading every nested file into its
// recreated parent. Sequential file fan-out — unlike every other bulk op in this codebase — because
// the in-memory sink above holds one whole file's bytes at a time; parallelizing would multiply peak
// memory by the fan-out width for no benefit mobile's own tmp-disk staging never had to trade off.
// Never throws: a sub-directory whose parent failed (or was itself skipped) skips its whole subtree,
// one nested failure never aborts the rest — the caller only learns whether anything failed.
export async function runImportDirectory(
	deps: RunImportDirectoryDeps,
	args: {
		item: Extract<DriveItem, { type: "directory" | "sharedDirectory" | "sharedRootDirectory" }>
		name: string
		parentUuid: string | null
	}
): Promise<VoidActionOutcome> {
	const { item, name, parentUuid } = args

	const rootOutcome = await runCreateDirectory(deps.createDirectory, parentUuid, name)

	if (rootOutcome.status === "error") {
		return { status: "error", dto: rootOutcome.dto }
	}

	const rootUuid = rootOutcome.item.data.uuid

	let scan: { listing: DirsAndFilesWithPaths; hadScanErrors: boolean }
	try {
		scan = await runOp(deps.listRecursive(toAnyDirWithContext(item)))
	} catch (e) {
		return { status: "error", dto: asErrorDTO(e) }
	}

	if (scan.hadScanErrors) {
		const message = i18n.t("drive:driveImportPartial")

		return { status: "error", dto: { species: "plain", message, label: message } }
	}

	// "" (the walked root itself) maps to the already-created rootUuid — every real sub-path's
	// dirnameOf resolves up the chain to this base case.
	const dirUuids = new Map<string, string>([["", rootUuid]])
	const orderedDirs = [...scan.listing.dirs].sort((a, b) => depthOf(a.path) - depthOf(b.path))
	let failedEntries = 0

	for (const { path } of orderedDirs) {
		const parentUuidForPath = dirUuids.get(dirnameOf(path) ?? "")

		if (parentUuidForPath === undefined) {
			failedEntries += 1
			continue
		}

		const outcome = await runCreateDirectory(deps.createDirectory, parentUuidForPath, basenameOf(path))

		if (outcome.status === "error") {
			failedEntries += 1
			continue
		}

		dirUuids.set(path, outcome.item.data.uuid)
	}

	for (const { path, file } of scan.listing.files) {
		const parentUuidForPath = dirUuids.get(dirnameOf(path) ?? "")

		if (parentUuidForPath === undefined || file.meta.type !== "decoded") {
			failedEntries += 1
			continue
		}

		const outcome = await runImportFile(deps.importFile, {
			file,
			name: file.meta.data.name,
			size: Number(file.size),
			mime: file.meta.data.mime,
			parentUuid: parentUuidForPath
		})

		// A cancelled nested file counts the same as a failed one here: silently leaving it out would
		// hand back a tree that LOOKS complete (status: "success") but is missing a file — the exact
		// hollowed-out-copy outcome this function's own doc comment above guards against.
		if (outcome.status === "error" || outcome.status === "cancelled") {
			failedEntries += 1
		}
	}

	if (failedEntries > 0) {
		const message = i18n.t("drive:driveImportPartial")

		return { status: "error", dto: { species: "plain", message, label: message } }
	}

	return { status: "success" }
}

// ── Per-item dispatch + the destination-picker's one call ───────────────

export interface RunImportDeps {
	createDirectory: CreateDirectoryDeps
	upload: RunUploadDeps
	download: RunImportDownloadDeps
	listRecursive: RunImportDirectoryDeps["listRecursive"]
}

// runBulk's perItem is throw-on-failure/resolve-on-success only — no third "neither" state — so a
// cancelled single-item import throws this identity-checked sentinel instead of a real ErrorDTO.
// importItems below filters it back out of BulkOutcome.failed before the caller ever sees it: not
// counted as succeeded (nothing was imported) and not counted as failed (the user asked for exactly
// this, it is not an error to surface), mirroring runDownload/runUpload's own cancel-is-not-a-failure
// convention at the single-op layer.
const IMPORT_CANCELLED = Symbol("import-cancelled")

async function importItem(deps: RunImportDeps, item: DriveItem, targetParentUuid: string | null): Promise<void> {
	const name = item.data.decryptedMeta?.name ?? item.data.uuid

	if (item.type === "directory" || item.type === "sharedDirectory" || item.type === "sharedRootDirectory") {
		const outcome = await runImportDirectory(
			{
				createDirectory: deps.createDirectory,
				importFile: { download: deps.download, upload: deps.upload },
				listRecursive: deps.listRecursive
			},
			{ item, name, parentUuid: targetParentUuid }
		)

		if (outcome.status === "error") {
			// eslint-disable-next-line @typescript-eslint/only-throw-error -- runBulk's per-item catch expects a plain ErrorDTO, mirrors runOp's own convention
			throw outcome.dto
		}

		return
	}

	let file: AnyFile
	try {
		file = narrowToAnyFile(item)
	} catch (e) {
		// eslint-disable-next-line @typescript-eslint/only-throw-error -- see the directory branch's own comment above
		throw asErrorDTO(e)
	}

	const mime = item.data.decryptedMeta?.mime

	const outcome = await runImportFile(
		{ download: deps.download, upload: deps.upload },
		{ file, name, size: Number(item.data.size), ...(mime !== undefined ? { mime } : {}), parentUuid: targetParentUuid }
	)

	if (outcome.status === "cancelled") {
		// eslint-disable-next-line @typescript-eslint/only-throw-error -- identity-checked sentinel, see IMPORT_CANCELLED's own comment above
		throw IMPORT_CANCELLED
	}

	if (outcome.status === "error") {
		// eslint-disable-next-line @typescript-eslint/only-throw-error -- see above
		throw outcome.dto
	}
}

export const defaultImportDeps: RunImportDeps = {
	createDirectory: {
		createDirectory: (parentUuid, name) => sdkApi.createDirectory(parentUuid, name),
		patchListing: driveListingQueryUpdate
	},
	upload: defaultUploadDeps,
	download: defaultImportDownloadDeps,
	listRecursive: dir => sdkApi.listDirectoryRecursiveForImport(dir)
}

// The destination picker's one call (moveTargetDialog.tsx's mode="import" branch) — same shape as
// moveItems (actions.ts) so the shared dialog can dispatch through the identical BulkOutcome/
// toastBulkOutcome path. Only ever invoked with a single item from the per-item menu today
// (itemMenu.logic.ts's IMPORT gates sharedIn only, dispatched one item at a time), but modeled as a
// bulk op for that reuse rather than a narrower single-item signature. Files fan out independently
// (runBulk, in parallel) — directories are internally sequential per the comment above, but a
// multi-item selection's separate directories still run in parallel against each other. A cancelled
// item is dropped from `failed` (see IMPORT_CANCELLED) before this resolves — moveTargetDialog.tsx's
// toastBulkOutcome already treats an all-empty BulkOutcome as a silent no-op, so a single cancelled
// import (today's only real caller shape) never shows a false success toast.
export async function importItems(items: DriveItem[], targetParentUuid: string | null): Promise<BulkOutcome<DriveItem>> {
	const outcome = await runBulk(items, item => importItem(defaultImportDeps, item, targetParentUuid))

	return { succeeded: outcome.succeeded, failed: outcome.failed.filter(failure => failure.error !== IMPORT_CANCELLED) }
}
