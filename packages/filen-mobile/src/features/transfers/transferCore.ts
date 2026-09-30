import auth from "@/lib/auth"
import logger from "@/lib/logger"
import { run, errorMessage } from "@filen/shared"
import * as FileSystem from "expo-file-system"
import { extnameOf } from "@/lib/previewType"
import {
	type Dir,
	File,
	type FileWithPath,
	type DirWithPath,
	FilenSdkError,
	ManagedFuture,
	AnyNormalDir,
	AnyNormalDir_Tags,
	type SharedFile,
	type DownloadError,
	type UploadError,
	type FilenSdkErrorInterface
} from "@filen/sdk-rs"
import useTransfersStore, { type Transfer, type FinishedTransfer } from "@/features/transfers/store/useTransfers.store"
import { unwrapDirMeta, unwrapFileMeta, unwrapParentUuid } from "@/lib/sdkUnwrap"
import { driveItemDisplayName } from "@/lib/decryption"
import { isDirectoryItem } from "@/features/drive/driveSelectors"
import { normalizeFilePathForExpo, normalizeFilePathForSdk } from "@/lib/paths"
import {
	wrapAbortSignalForSdk,
	disposeSdkAbortSignal,
	PauseSignal,
	createCompositeAbortSignal,
	createCompositePauseSignal
} from "@/lib/signals"
import {
	driveItemsQueryUpsertManyForNormalParent,
	driveItemsQueryUpsertManyIntoPhotos,
	driveItemsQueryUpdateForRecents
} from "@/features/drive/queries/useDriveItems.query"
import { markDirectorySizesStale } from "@/features/drive/queries/useDirectorySize.query"
import { addAccountStorageUsed } from "@/queries/useAccount.query"
import type { DriveItem } from "@/types"
import { driveItemToAnyDirWithContext, driveItemToAnyFile } from "@/lib/sdkSources"
import cache from "@/lib/cache"
import fileCache from "@/lib/fileCache"
import drive from "@/features/drive/drive"
import thumbnails from "@/lib/thumbnails"
import { EXPO_VIDEO_SUPPORTED_EXTENSIONS } from "@/constants"
import { randomUUID } from "expo-crypto"

function isTransferOfType<T extends Transfer["type"]>(transfer: Transfer, type: T): transfer is Extract<Transfer, { type: T }> {
	return transfer.type === type
}

// One map over the active list per event, replacing only the entry with this id and type.
function patchTransfer<T extends Transfer["type"]>(
	id: string,
	type: T,
	patch: (transfer: Extract<Transfer, { type: T }>) => Extract<Transfer, { type: T }>
): void {
	useTransfersStore.getState().setTransfers(prev => prev.map(t => (t.id === id && isTransferOfType(t, type) ? patch(t) : t)))
}

// Registers pause/resume event listeners on both the per-transfer and global PauseSignals,
// and queues their removal via defer() so the `run` cleanup block tears them down automatically.
function registerPauseListeners(
	id: string,
	type: Transfer["type"],
	transferPauseSignal: PauseSignal,
	globalPauseSignal: PauseSignal,
	defer: (fn: () => void) => void
): void {
	const setPaused = (paused: boolean) => {
		patchTransfer(id, type, t => ({
			...t,
			paused
		}))
	}

	const onPause = () => setPaused(true)
	const onResume = () => setPaused(false)

	transferPauseSignal.addEventListener("pause", onPause)
	transferPauseSignal.addEventListener("resume", onResume)

	globalPauseSignal.addEventListener("pause", onPause)
	globalPauseSignal.addEventListener("resume", onResume)

	defer(() => {
		transferPauseSignal.removeEventListener("pause", onPause)
		transferPauseSignal.removeEventListener("resume", onResume)

		globalPauseSignal.removeEventListener("pause", onPause)
		globalPauseSignal.removeEventListener("resume", onResume)
	})
}

// Pure decision predicate for whether a settled transfer entry should be removed from the store.
// A transfer that succeeded, was aborted, OR finished with errors has reached a terminal state and
// must be dropped — otherwise the floating bar, the Android foreground service and the speed
// interval stay alive forever (the errored case was previously missed). A still-running transfer
// (none of the three) is kept.
export function shouldRemoveSettledTransfer(args: { succeeded: boolean; aborted: boolean; hasErrors: boolean }): boolean {
	return args.succeeded || args.aborted || args.hasErrors
}

// Total number of per-entry errors accumulated on a live transfer entry across all error
// buckets (upload/download + scan + unknown). Directory transfers can resolve Ok while
// individual entries failed — the SDK surfaces those ONLY via the error callbacks
// (onUploadErrors/onDownloadErrors), so the settle path must read the accumulated state
// instead of trusting resolution alone.
export function countTransferErrors(transfer: Transfer): number {
	// A copy's failures live on its job (useCopyJobs.store), not on the row.
	if (transfer.type === "copy") {
		return 0
	}

	if (transfer.type === "uploadDirectory" || transfer.type === "uploadFile") {
		return transfer.errors.upload.length + transfer.errors.scan.length + transfer.errors.unknown.length
	}

	return transfer.errors.download.length + transfer.errors.scan.length + transfer.errors.unknown.length
}

// Display name for a settled transfer, matching the transfers screen row exactly:
// uploads use the effective remote name, downloads use the drive item's decrypted name.
function finishedTransferName(transfer: Transfer): string {
	if (transfer.type === "uploadDirectory" || transfer.type === "uploadFile" || transfer.type === "copy") {
		return transfer.name
	}

	return driveItemDisplayName(transfer.item)
}

// Builds a flat, closure-free snapshot of a settled transfer for the finished list. Reads the
// LIVE store entry (latest bytesTransferred/size/startedAt) at settle time; if it is already gone
// (defensive — e.g. removed by another path) returns null and the caller skips the append.
function buildFinishedSnapshot(args: {
	id: string
	type: Transfer["type"]
	outcome: FinishedTransfer["outcome"]
	errorMessage: string | null
}): FinishedTransfer | null {
	const { id, type, outcome, errorMessage } = args
	const liveEntry = useTransfersStore.getState().transfers.find(t => t.id === id && t.type === type)

	if (!liveEntry) {
		return null
	}

	return {
		id,
		type,
		name: finishedTransferName(liveEntry),
		size: liveEntry.size,
		bytesTransferred: liveEntry.bytesTransferred,
		startedAt: liveEntry.startedAt,
		finishedAt: Date.now(),
		outcome,
		errorMessage,
		errorCount: countTransferErrors(liveEntry)
	}
}

// Unwraps a thrown transfer error into a single diagnostic line for the finished list. Reads the
// SDK's inner message directly via FilenSdkError (no i18n / human-readable kind localization — that
// path drags the localization runtime into this silent infra module and the UI alert layer already
// owns the translated presentation). Falls back to the JS Error message / stringified value.
function finishedTransferErrorMessage(error: unknown): string | null {
	if (FilenSdkError.hasInner(error)) {
		const inner = FilenSdkError.getInner(error)

		return inner.message()
	}

	return errorMessage(error)
}

// Removes the transfer entry from the store, optionally waiting for an external completion gate
// first (e.g. camera upload finishing its own bookkeeping). Shared by the deferred success/abort
// cleanup and the error-write paths so the removal logic stays in one place. When `outcome` is set
// (succeeded/errored — never aborted), a finished snapshot is appended in the SAME deferred step,
// AFTER the external-completion fence resolves and BEFORE the active entry is filtered out, so the
// snapshot captures the entry's final state and the fence stays intact.
function removeSettledTransfer(
	id: string,
	type: Transfer["type"],
	args?: {
		awaitExternal?: () => Promise<void>
		outcome?: FinishedTransfer["outcome"]
		errorMessage?: string | null
	}
): void {
	const awaitExternal = args?.awaitExternal
	const outcome = args?.outcome
	const errorMessage = args?.errorMessage ?? null

	;(awaitExternal ? awaitExternal() : Promise.resolve())
		.catch(err => {
			// TC-07: a rejecting external-completion fence (camera-upload / Android MediaStore) must NOT
			// block the mandatory store removal in the .then() below — otherwise the transfer is stranded
			// as a zombie row with a never-stopping speed interval (and, on Android, a foreground-service
			// notification that never clears). Swallow it (logged) and fall through to the removal.
			logger.warn("transfers", "external-completion fence rejected; removing the transfer anyway", { id, type, error: err })
		})
		.then(() => {
			if (outcome) {
				// Append before the filter so the finished entry exists by the time the active one is
				// dropped. Guarded so a snapshot/append failure never blocks the (mandatory) removal.
				try {
					const snapshot = buildFinishedSnapshot({ id, type, outcome, errorMessage })
					const addFinishedTransfer = useTransfersStore.getState().addFinishedTransfer

					if (snapshot && typeof addFinishedTransfer === "function") {
						addFinishedTransfer(snapshot)
					}
				} catch (e) {
					logger.error("transfers", "Failed to append finished transfer snapshot", { id, type, outcome, error: e })
				}
			}

			useTransfersStore.getState().setTransfers(prev => prev.filter(t => !(t.id === id && t.type === type)))
		})
		.catch(err => logger.error("transfers", "removeSettledTransfer cleanup chain rejected", { id, type, outcome, error: err }))
}

// Writes a thrown transfer error to its row, then settles the row as errored. The caller rethrows so the
// error still reaches its alert path; the removal only stops the floating bar, foreground service and
// speed interval from staying alive forever, keeping an errored snapshot in the finished list.
function recordTransferFailure(args: {
	id: string
	type: "uploadDirectory" | "uploadFile" | "downloadDirectory" | "downloadFile"
	uri: string
	error: unknown
	awaitExternal: (() => Promise<void>) | undefined
}): void {
	const { id, type, uri, error, awaitExternal } = args
	const toUnknown = (): Error => (error instanceof Error ? error : new Error(String(error)))

	if (type === "uploadDirectory" || type === "uploadFile") {
		patchTransfer(id, type, t => ({
			...t,
			errors: {
				...t.errors,
				...(FilenSdkError.hasInner(error)
					? {
							upload: [
								...t.errors.upload,
								{
									error: FilenSdkError.getInner(error),
									path: normalizeFilePathForSdk(uri)
								}
							]
						}
					: {
							unknown: [...t.errors.unknown, toUnknown()]
						})
			}
		}))
	} else {
		patchTransfer(id, type, t => ({
			...t,
			errors: {
				...t.errors,
				...(FilenSdkError.hasInner(error)
					? {
							download: [
								...t.errors.download,
								{
									path: normalizeFilePathForSdk(uri),
									error: FilenSdkError.getInner(error)
								}
							]
						}
					: {
							unknown: [...t.errors.unknown, toUnknown()]
						})
			}
		}))
	}

	removeSettledTransfer(id, type, {
		awaitExternal,
		outcome: "errored",
		errorMessage: finishedTransferErrorMessage(error)
	})
}

// Registers a deferred cleanup that removes the transfer entry from the store once the transfer
// succeeds or is aborted. The errored case is handled separately in the post-`run` error blocks:
// the deferred callback runs inside `run`'s `finally` (before `await run(...)` resolves), so at this
// point the error has not yet been appended to the store entry — removing it here would race the
// error write and could hide the failure from the transfers screen. The `succeeded` and `aborted`
// arguments are getter functions so they capture the latest value at cleanup time, not at registration time.
function registerCompletionCleanup(args: {
	id: string
	type: Transfer["type"]
	succeeded: () => boolean
	aborted: () => boolean
	awaitExternal?: () => Promise<void>
	defer: (fn: () => void) => void
}): void {
	const { id, type, succeeded, aborted, awaitExternal, defer } = args

	defer(() => {
		const didSucceed = succeeded()
		const wasAborted = aborted()

		// Settle honesty: a directory transfer resolves Ok even when individual entries failed
		// (the SDK reports those only via onUploadErrors/onDownloadErrors), so read the LIVE
		// entry's accumulated errors at settle time instead of stamping "succeeded" on resolution
		// alone. Only the resolved-non-aborted case reads them — the thrown case must keep
		// errorCount 0 here so the predicate below stays false and the post-`run` error blocks
		// own that settle (see function docstring), and aborted transfers stay silently dropped.
		const liveEntry =
			didSucceed && !wasAborted ? useTransfersStore.getState().transfers.find(t => t.id === id && t.type === type) : undefined
		const errorCount = liveEntry ? countTransferErrors(liveEntry) : 0

		if (!shouldRemoveSettledTransfer({ succeeded: didSucceed, aborted: wasAborted, hasErrors: errorCount > 0 })) {
			return
		}

		// User-aborted/cancelled transfers are dropped silently — only a genuine settle is kept in
		// the finished list. (Abort wins over success if both are somehow true.)
		removeSettledTransfer(id, type, {
			awaitExternal,
			outcome: didSucceed && !wasAborted ? (errorCount > 0 ? "completedWithErrors" : "succeeded") : undefined
		})
	})
}

// Per-transfer controller and composite signals, plus the row controls and settle wiring every branch shares.
function createTransferSession(
	globalAbortController: AbortController,
	globalPauseSignal: PauseSignal,
	{ signal, awaitExternal }: { signal: AbortSignal | undefined; awaitExternal: (() => Promise<void>) | undefined }
) {
	const id = randomUUID()
	const transferAbortController = new AbortController()
	// Its inner SdkPauseSignal is a uniffi (Rust Arc-backed) handle, disposed once the transfer settles.
	const transferPauseSignal = new PauseSignal()
	const compositePauseSignal = createCompositePauseSignal(globalPauseSignal, transferPauseSignal)
	const compositeAbortSignal = signal
		? createCompositeAbortSignal(globalAbortController.signal, transferAbortController.signal, signal)
		: createCompositeAbortSignal(globalAbortController.signal, transferAbortController.signal)

	const isAborted = (): boolean =>
		transferAbortController.signal.aborted || globalAbortController.signal.aborted || (signal?.aborted ?? false)

	return {
		id,
		compositePauseSignal,
		compositeAbortSignal,
		isAborted,
		controls: {
			abort: () => {
				if (transferAbortController.signal.aborted) {
					return
				}

				transferAbortController.abort()
			},
			pause: () => {
				transferPauseSignal.pause()
			},
			resume: () => {
				transferPauseSignal.resume()
			}
		},
		// wrapAbortSignalForSdk allocates a uniffi (Rust Arc-backed) ManagedAbortSignal that must be released
		// explicitly, and its `new ManagedAbortController()` can throw under memory pressure. Arm the disposal
		// defer() BEFORE that allocation, or an early throw leaks the composite handles created above (TC-08).
		// Returns the allocator; whatever it allocated is disposed with the rest.
		armDisposal: (defer: (fn: () => void) => void): (() => ReturnType<typeof wrapAbortSignalForSdk>) => {
			let wrappedAbortSignal: ReturnType<typeof wrapAbortSignalForSdk> | null = null

			defer(() => {
				compositePauseSignal.dispose()
				compositeAbortSignal.dispose()
				disposeSdkAbortSignal(wrappedAbortSignal)
				transferPauseSignal.dispose()
			})

			return () => {
				wrappedAbortSignal = wrapAbortSignalForSdk(compositeAbortSignal)

				return wrappedAbortSignal
			}
		},
		register: (defer: (fn: () => void) => void, type: Transfer["type"], succeeded: () => boolean): void => {
			registerPauseListeners(id, type, transferPauseSignal, globalPauseSignal, defer)
			registerCompletionCleanup({
				id,
				type,
				succeeded,
				aborted: isAborted,
				awaitExternal,
				defer
			})
		}
	}
}

export type UploadParams = {
	localFileOrDir: FileSystem.File | FileSystem.Directory
	parent: AnyNormalDir
	// Background abort-scope. true = a sync-engine transfer launched by the OS background task (idempotent /
	// retried; survives an app→background transition via the foreground service). Omitted/false = a manual or
	// foreground-initiated transfer, cancelled when the app backgrounds without an active foreground service.
	background?: boolean
	awaitExternalCompletionBeforeMarkingAsFinished?: () => Promise<void>
	signal?: AbortSignal
	name?: string
	created?: number
	modified?: number
	mime?: string
}

export type DownloadParams = {
	item: DriveItem
	destination: FileSystem.File | FileSystem.Directory
	// Background abort-scope. true = a sync-engine transfer launched by the OS background task (idempotent /
	// retried; survives an app→background transition via the foreground service). Omitted/false = a manual or
	// foreground-initiated transfer, cancelled when the app backgrounds without an active foreground service.
	background?: boolean
	awaitExternalCompletionBeforeMarkingAsFinished?: () => Promise<void>
	signal?: AbortSignal
	// When true, a directory download must NOT pre-delete an existing populated destination before the
	// recursive download starts (nor delete it again on a non-abort failure). Used by the offline layer's
	// in-place tree reconcile, where the destination IS the live stored tree: the Rust downloader is
	// hash-idempotent per file, so existing healthy bytes are skipped and any failure must leave them
	// intact for the next reconcile pass. Defaults to false → the original destructive behavior is
	// preserved for every other (non-offline) caller, which downloads into a fresh/disposable destination.
	preserveDestinationOnStart?: boolean
	// When true, a FILE download skips the fileCache/offline "already have it" shortcut and always
	// re-downloads via the SDK. Used by the offline standalone self-heal, whose destination IS the
	// offline file's own path: the shortcut resolves the source (offline.getLocalFile) to that SAME
	// path, then the branch deletes the destination and copies the now-deleted file onto itself —
	// destroying the bytes the heal exists to replace (TC-04). Defaults to false.
	bypassCache?: boolean
}

// Performs an upload against the SDK with full progress tracking. The two global signals
// (abort / pause) are passed in by the Transfers controller so cancelAll()/pauseAll() can
// reach every in-flight transfer. Extracted verbatim from the Transfers.upload method.
export async function uploadCore(
	globalAbortController: AbortController,
	globalPauseSignal: PauseSignal,
	{
		localFileOrDir,
		parent,
		awaitExternalCompletionBeforeMarkingAsFinished,
		signal,
		name,
		created,
		modified,
		mime
	}: UploadParams
): Promise<
	| {
			files: File[]
			directories: Dir[]
			errors: UploadError[]
	  }
	| {
			files: File[]
			directories: Dir[]
	  }
	| null
> {
	const { authedSdkClient } = await auth.getSdkClients()
	const session = createTransferSession(globalAbortController, globalPauseSignal, {
		signal,
		awaitExternal: awaitExternalCompletionBeforeMarkingAsFinished
	})
	const { id, compositePauseSignal, compositeAbortSignal, isAborted } = session

	if (localFileOrDir instanceof FileSystem.Directory) {
		// Summed per batch and added to the cached account once the upload settles, not per batch.
		let ownBytesUploaded = 0n

		const result = await run(async defer => {
			const wrappedAbortSignal = session.armDisposal(defer)()

			if (!localFileOrDir.exists) {
				throw new Error("Local directory does not exist or is empty.")
			}

			useTransfersStore.getState().setTransfers(prev => [
				...prev,
				{
					id,
					localFileOrDir,
					parent,
					type: "uploadDirectory",
					// Directory uploads create the remote dir under the LOCAL name (see
					// createDirectory below) — the display name must match that outcome.
					name: localFileOrDir.name,
					size: 0,
					bytesTransferred: 0,
					startedAt: Date.now(),
					paused: false,
					errors: {
						unknown: [],
						scan: [],
						upload: []
					},
					...session.controls
				}
			])

			let succeededUploadDirectory = false

			session.register(defer, "uploadDirectory", () => succeededUploadDirectory)

			const parentDir = await (async () => {
				const created = await drive.createDirectory({
					parent:
						parent.tag === AnyNormalDir_Tags.Root
							? new AnyNormalDir.Root(parent.inner[0])
							: new AnyNormalDir.Dir(parent.inner[0]),
					signal: compositeAbortSignal,
					name: localFileOrDir.name
				})

				return created.data
			})()

			const transferred: {
				files: File[]
				directories: Dir[]
				errors: UploadError[]
			} = {
				files: [],
				directories: [],
				errors: []
			}

			await authedSdkClient.uploadDirRecursively(
				normalizeFilePathForSdk(localFileOrDir.uri),
				{
					onScanComplete(_totalDirs, _totalFiles, totalBytes) {
						patchTransfer(id, "uploadDirectory", t => ({
							...t,
							size: Number(totalBytes)
						}))
					},
					onScanErrors(errors) {
						patchTransfer(id, "uploadDirectory", t => ({
							...t,
							errors: {
								...t.errors,
								scan: [...t.errors.scan, ...errors]
							}
						}))
					},
					onScanProgress(_knownDirs, _knownFiles, knownBytes) {
						patchTransfer(id, "uploadDirectory", t => ({
							...t,
							size: Number(knownBytes)
						}))
					},
					onUploadErrors(errors) {
						patchTransfer(id, "uploadDirectory", t => ({
							...t,
							errors: {
								...t.errors,
								upload: [...t.errors.upload, ...errors]
							}
						}))
						// The SDK resolves Ok despite per-entry failures — thread them into the resolved
						// value (mirrors downloadCore's directory branch) so callers can act on partial
						// uploads instead of trusting resolution alone.
						transferred.errors.push(...errors)
					},
					onUploadUpdate(uploadedDirs, uploadedFiles, uploadedBytes) {
						patchTransfer(id, "uploadDirectory", t => ({
							...t,
							bytesTransferred: t.bytesTransferred + Number(uploadedBytes)
						}))

						for (const uploadedDir of uploadedDirs) {
							transferred.directories.push(uploadedDir)

							const unwrappedDirMeta = unwrapDirMeta(uploadedDir)
							const dirParentUuid = unwrapParentUuid(uploadedDir.parent)

							if (!unwrappedDirMeta.shared && dirParentUuid) {
								const driveItem = {
									type: "directory" as const,
									data: {
										...unwrappedDirMeta.dir,
										size: 0n,
										decryptedMeta: unwrappedDirMeta.meta,
										undecryptable: unwrappedDirMeta.meta === null
									}
								}

								cache.cacheNewNormalDir(uploadedDir, driveItem)

								// Cached just above; the listing's other rows were cached when they got there.
								driveItemsQueryUpsertManyForNormalParent({
									parentUuid: dirParentUuid,
									items: [driveItem]
								})
							}
						}

						for (const uploadedFile of uploadedFiles) {
							transferred.files.push(uploadedFile)

							const unwrappedFileMeta = unwrapFileMeta(uploadedFile)
							const fileParentUuid = unwrapParentUuid(uploadedFile.parent)

							if (!unwrappedFileMeta.shared && fileParentUuid) {
								const driveItem = {
									type: "file" as const,
									data: {
										...unwrappedFileMeta.file,
										decryptedMeta: unwrappedFileMeta.meta,
										undecryptable: unwrappedFileMeta.meta === null
									}
								}

								cache.cacheNewFile(uploadedFile, driveItem)

								driveItemsQueryUpsertManyForNormalParent({
									parentUuid: fileParentUuid,
									items: [driveItem]
								})
							}

							// TODO: Add thumbnail generation for uploaded files here once sdk exposes different type with path
						}

						if (uploadedDirs.length > 0 || uploadedFiles.length > 0) {
							markDirectorySizesStale()
						}

						for (const uploadedFile of uploadedFiles) {
							if (!unwrapFileMeta(uploadedFile).shared) {
								ownBytesUploaded += uploadedFile.size
							}
						}
					}
				},
				parentDir,
				ManagedFuture.new({
					pauseSignal: compositePauseSignal.getSignal(),
					abortSignal: wrappedAbortSignal
				}),
				{
					signal: compositeAbortSignal
				}
			)

			succeededUploadDirectory = true

			return transferred
		})

		// What reached the server counts however the upload ended. Not after Cancel all or sign-out, whose
		// session may already be wiped; the batches marked the account stale, so its next read corrects it.
		if (!globalAbortController.signal.aborted) {
			addAccountStorageUsed(ownBytesUploaded)
		}

		if (!result.success) {
			if (isAborted()) {
				// Don't treat abort errors as actual errors to be shown in the UI
				return null
			}

			logger.error("transfers", "Directory upload failed", { id, error: result.error })

			recordTransferFailure({
				id,
				type: "uploadDirectory",
				uri: localFileOrDir.uri,
				error: result.error,
				awaitExternal: awaitExternalCompletionBeforeMarkingAsFinished
			})

			throw result.error
		}

		return result.data
	}

	const result = await run(async defer => {
		const wrappedAbortSignal = session.armDisposal(defer)()

		if (!localFileOrDir.exists) {
			throw new Error("Local file does not exist.")
		}

		useTransfersStore.getState().setTransfers(prev => [
			...prev,
			{
				id,
				localFileOrDir,
				parent,
				type: "uploadFile",
				// Same expression the SDK call below uploads under — the row shows the file's
				// REMOTE name, not a staged tmp source's random one.
				name: name ?? localFileOrDir.name,
				size: localFileOrDir.size,
				bytesTransferred: 0,
				startedAt: Date.now(),
				paused: false,
				errors: {
					unknown: [],
					scan: [],
					upload: []
				},
				...session.controls
			}
		])

		let succeededUploadFile = false

		session.register(defer, "uploadFile", () => succeededUploadFile)

		const transferred = await authedSdkClient.uploadFile(
			{
				parent,
				name: name ?? localFileOrDir.name ?? undefined,
				// Null-guard (NOT falsy): 0 is a valid epoch timestamp — camera upload
				// relies on created=0 surviving for assets without any usable timestamp,
				// or its dedup identity diverges from the remote listing.
				created: created != null ? BigInt(created) : undefined,
				modified: modified != null ? BigInt(modified) : undefined,
				mime: mime ?? undefined,
				noExif: false,
				noExifOverride: false
			},
			normalizeFilePathForSdk(localFileOrDir.uri),
			{
				onUpdate(uploadedBytes) {
					patchTransfer(id, "uploadFile", t => ({
						...t,
						bytesTransferred: t.bytesTransferred + Number(uploadedBytes)
					}))
				}
			},
			ManagedFuture.new({
				pauseSignal: compositePauseSignal.getSignal(),
				abortSignal: wrappedAbortSignal
			}),
			{
				signal: compositeAbortSignal
			}
		)

		succeededUploadFile = true

		return transferred
	})

	if (!result.success) {
		if (isAborted()) {
			// Don't treat abort errors as actual errors to be shown in the UI
			return null
		}

		logger.error("transfers", "File upload failed", { id, error: result.error })

		recordTransferFailure({
			id,
			type: "uploadFile",
			uri: localFileOrDir.uri,
			error: result.error,
			awaitExternal: awaitExternalCompletionBeforeMarkingAsFinished
		})

		throw result.error
	}

	const unwrappedFileMeta = unwrapFileMeta(result.data)

	markDirectorySizesStale()

	// The server now counts these bytes; the quota pre-flight's cached figure follows without a read.
	// A file in someone else's share counts against its owner.
	if (!unwrappedFileMeta.shared) {
		addAccountStorageUsed(result.data.size)
	}

	if (!unwrappedFileMeta.shared) {
		const driveItem = {
			type: "file" as const,
			data: {
				...unwrappedFileMeta.file,
				decryptedMeta: unwrappedFileMeta.meta,
				undecryptable: unwrappedFileMeta.meta === null
			}
		}

		// Mirror the new file into the session uuid caches so downstream
		// reads (useFileUrlQuery, drive item info, etc.) work without a
		// manual refetch. Matches what useDriveItems.query.ts:fetchData()
		// does inline on each fetch.
		cache.cacheNewFile(result.data, driveItem)

		// The upsert helpers leave the listings' other rows uncached again: they were cached when they got
		// there, and re-caching the whole Photos grid per file multiplies across a camera-upload backfill.
		driveItemsQueryUpsertManyForNormalParent({
			parentUuid: parent.inner[0].uuid,
			items: [driveItem]
		})

		// Surface the new file in the two virtual-root queries it can belong to — both SEPARATE from the
		// parent's `drive` listing. Photos: the recursive camera-upload-root grid, gated by parentUuid so an
		// upload OUTSIDE that subtree is never wrongly inserted (it would linger until the grid refetches).
		// Recents: any new file is recent, so it always qualifies. Dedupe by uuid (the flat/recursive lists
		// can hold the same name twice).
		driveItemsQueryUpsertManyIntoPhotos([
			{
				parentUuid: parent.inner[0].uuid,
				item: driveItem
			}
		])

		driveItemsQueryUpdateForRecents({
			updater: prev => [...prev.filter(item => item.data.uuid !== result.data.uuid), driveItem]
		})
	}

	const uploadedFileName = name ?? localFileOrDir.name ?? ""
	const ext = extnameOf(uploadedFileName).toLowerCase().trim()
	const canMakeThumbnail = result.data.canMakeThumbnail === true

	// A cheap superset of the real gate, not a second definition of it: either half can still admit
	// this file, so it is worth waking the thumbnailer, which decides for real against the same
	// name classifier every drive row uses. Anything the real gate accepts passes this one — an image
	// only qualifies there with the flag set, and a video only with an extension from this set.
	if (canMakeThumbnail || EXPO_VIDEO_SUPPORTED_EXTENSIONS.has(ext)) {
		// TC-02: thumbnail generation runs AFTER the run() above settles, but run()'s finally already
		// disposed compositeAbortSignal — and createCompositeAbortSignal.dispose() detaches its parent
		// listeners, so the disposed composite can never transition to aborted again (the thumbnail would
		// be uncancellable). Build a FRESH composite of the still-live parents (global cancelAll + the
		// caller's signal) so this best-effort post-upload work stays abortable, and dispose it once the
		// thumbnail settles.
		const thumbnailAbortSignal = signal
			? createCompositeAbortSignal(globalAbortController.signal, signal)
			: createCompositeAbortSignal(globalAbortController.signal)

		await thumbnails
			.generateFromLocalFile({
				// The percent-ENCODED expo URI, which is what `File.uri` already is — the form each
				// branch derives its own from (the SDK decode wants the path decoded, the video
				// extractor wants the URI). Decoding here instead would strand the video branch: the
				// helper it re-normalizes with decodes before it encodes, so a name holding a literal
				// `%20` would decode twice and address a file that does not exist.
				localUri: normalizeFilePathForExpo(localFileOrDir.uri),
				uuid: result.data.uuid,
				name: uploadedFileName,
				canMakeThumbnail,
				signal: thumbnailAbortSignal
			})
			.catch(err => {
				logger.warn("transfers", "Thumbnail generation failed after upload", {
					uuid: result.data.uuid,
					name: uploadedFileName,
					error: err
				})
			})
			.finally(() => {
				thumbnailAbortSignal.dispose()
			})
	}

	return {
		files: [result.data],
		directories: []
	}
}

type DownloadFileResult = {
	files: (Omit<FileWithPath, "file"> & {
		file: File | SharedFile
	})[]
	directories: DirWithPath[]
}

// Performs a download against the SDK with full progress tracking. Mirrors uploadCore.
export async function downloadCore(
	globalAbortController: AbortController,
	globalPauseSignal: PauseSignal,
	{
		item,
		destination,
		awaitExternalCompletionBeforeMarkingAsFinished,
		signal,
		preserveDestinationOnStart,
		bypassCache
	}: DownloadParams
): Promise<
	| {
			errors: DownloadError[]
			scanErrors: FilenSdkErrorInterface[]
	  }
	| DownloadFileResult
	| null
> {
	const { authedSdkClient } = await auth.getSdkClients()
	const session = createTransferSession(globalAbortController, globalPauseSignal, {
		signal,
		awaitExternal: awaitExternalCompletionBeforeMarkingAsFinished
	})
	const { id, compositePauseSignal, compositeAbortSignal, isAborted } = session

	if (isDirectoryItem(item)) {
		const result = await run(async defer => {
			const wrappedAbortSignal = session.armDisposal(defer)()

			if (destination instanceof FileSystem.File) {
				throw new Error("Destination must be a directory for directory downloads.")
			}

			useTransfersStore.getState().setTransfers(prev => [
				...prev,
				{
					id,
					item,
					type: "downloadDirectory",
					size: 0,
					bytesTransferred: 0,
					startedAt: Date.now(),
					paused: false,
					errors: {
						unknown: [],
						scan: [],
						download: []
					},
					destination,
					...session.controls
				}
			])

			let succeededDownloadDirectory = false

			session.register(defer, "downloadDirectory", () => succeededDownloadDirectory)

			// Downloaded items are not retained: no directory caller reads them, and a large tree would
			// hold every lifted SDK record until the transfer settles.
			const transferred: {
				errors: DownloadError[]
				// SDK-side tree-scan errors. A failed scan silently DROPS the affected subtree from
				// the download set while the call still resolves Ok — callers that verify
				// completeness (the offline layer) need these to tell "scan-degraded" from "done".
				scanErrors: FilenSdkErrorInterface[]
			} = {
				errors: [],
				scanErrors: []
			}

			const targetDir = driveItemToAnyDirWithContext(item)

			if (!preserveDestinationOnStart && destination.exists) {
				destination.delete()
			}

			await authedSdkClient.downloadDirRecursively(
				normalizeFilePathForSdk(destination.uri),
				{
					onDownloadErrors(errors) {
						patchTransfer(id, "downloadDirectory", t => ({
							...t,
							errors: {
								...t.errors,
								download: [...t.errors.download, ...errors]
							}
						}))
						transferred.errors.push(...errors)
					},
					onDownloadUpdate(_downloadedDirs, _downloadedFiles, downloadedBytes) {
						patchTransfer(id, "downloadDirectory", t => ({
							...t,
							bytesTransferred: t.bytesTransferred + Number(downloadedBytes)
						}))
					},
					// Required by the callback interface; listing-fetch progress has no reader.
					onQueryDownloadProgress() {},
					onScanComplete(_totalDirs, _totalFiles, totalBytes) {
						patchTransfer(id, "downloadDirectory", t => ({
							...t,
							size: Number(totalBytes)
						}))
					},
					onScanErrors(errors) {
						transferred.scanErrors.push(...errors)

						patchTransfer(id, "downloadDirectory", t => ({
							...t,
							errors: {
								...t.errors,
								scan: [...t.errors.scan, ...errors]
							}
						}))
					},
					onScanProgress(_knownDirs, _knownFiles, knownBytes) {
						patchTransfer(id, "downloadDirectory", t => ({
							...t,
							size: Number(knownBytes)
						}))
					}
				},
				targetDir,
				ManagedFuture.new({
					pauseSignal: compositePauseSignal.getSignal(),
					abortSignal: wrappedAbortSignal
				}),
				{
					signal: compositeAbortSignal
				}
			)

			succeededDownloadDirectory = true

			return transferred
		})

		if (!result.success) {
			// When the offline layer owns the destination (in-place reconcile of a live stored tree), a
			// failed pass must leave the existing bytes for the next reconcile — so don't delete here.
			// Every other caller downloads into a fresh destination and relies on this cleanup.
			if (!preserveDestinationOnStart && destination.exists) {
				destination.delete()
			}

			if (isAborted()) {
				// Don't treat abort errors as actual errors to be shown in the UI
				return null
			}

			logger.error("transfers", "Directory download failed", { id, error: result.error })

			recordTransferFailure({
				id,
				type: "downloadDirectory",
				uri: destination.uri,
				error: result.error,
				awaitExternal: awaitExternalCompletionBeforeMarkingAsFinished
			})

			throw result.error
		}

		return result.data
	}

	const result = await run(async defer => {
		const wrapAbortSignal = session.armDisposal(defer)

		if (!(destination instanceof FileSystem.File)) {
			throw new Error("Destination must be a file for file downloads.")
		}

		const remoteAnyFile = driveItemToAnyFile(item)

		if (!remoteAnyFile) {
			throw new Error("Not a file item")
		}

		useTransfersStore.getState().setTransfers(prev => [
			...prev,
			{
				id,
				item,
				type: "downloadFile",
				size: Number(item.data.size),
				bytesTransferred: 0,
				startedAt: Date.now(),
				paused: false,
				errors: {
					unknown: [],
					scan: [],
					download: []
				},
				destination,
				...session.controls
			}
		])

		let succeededDownloadFile = false

		session.register(defer, "downloadFile", () => succeededDownloadFile)

		const cachedOrOfflineFile = await run(async () => {
			// TC-04: the offline self-heal's destination IS the offline file's own path, which the cache
			// shortcut resolves the source to — skip the shortcut entirely and re-download fresh.
			if (bypassCache) {
				return null
			}

			if (
				await fileCache.has({
					type: "drive",
					data: item
				})
			) {
				return await fileCache.get({
					item: {
						type: "drive",
						data: item
					},
					signal: compositeAbortSignal
				})
			}

			return null
		})

		if (destination.exists) {
			destination.delete()
		}

		if (cachedOrOfflineFile.success && cachedOrOfflineFile.data) {
			await cachedOrOfflineFile.data.copy(destination)

			patchTransfer(id, "downloadFile", t => ({
				...t,
				bytesTransferred: Number(item.data.size)
			}))
		} else {
			// Allocated lazily: cache hits above never reach the SDK download.
			const wrappedAbortSignal = wrapAbortSignal()

			await authedSdkClient.downloadFileToPath(
				remoteAnyFile,
				normalizeFilePathForSdk(destination.uri),
				{
					onUpdate(downloadedBytes) {
						patchTransfer(id, "downloadFile", t => ({
							...t,
							bytesTransferred: t.bytesTransferred + Number(downloadedBytes)
						}))
					}
				},
				ManagedFuture.new({
					pauseSignal: compositePauseSignal.getSignal(),
					abortSignal: wrappedAbortSignal
				}),
				{
					signal: compositeAbortSignal
				}
			)
		}

		const transferred: DownloadFileResult = {
			files: [
				{
					path: normalizeFilePathForSdk(destination.uri),
					file: item.data
				}
			],
			directories: []
		}

		succeededDownloadFile = true

		return transferred
	})

	if (!result.success) {
		if (destination.exists) {
			destination.delete()
		}

		if (isAborted()) {
			// Don't treat abort errors as actual errors to be shown in the UI
			return null
		}

		logger.error("transfers", "File download failed", { id, error: result.error })

		recordTransferFailure({
			id,
			type: "downloadFile",
			uri: destination.uri,
			error: result.error,
			awaitExternal: awaitExternalCompletionBeforeMarkingAsFinished
		})

		throw result.error
	}

	return result.data
}
