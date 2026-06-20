import auth from "@/lib/auth"
import logger from "@/lib/logger"
import { run } from "@filen/utils"
import * as FileSystem from "expo-file-system"
import {
	type Dir,
	File,
	type FileWithPath,
	type DirWithPath,
	FilenSdkError,
	ManagedFuture,
	AnyDirWithContext,
	AnySharedDirWithContext,
	AnySharedDir,
	AnyNormalDir,
	AnyNormalDir_Tags,
	AnyFile,
	type SharedFile,
	type DownloadError,
	type UploadError,
	type FilenSdkErrorInterface
} from "@filen/sdk-rs"
import useTransfersStore, { type Transfer, type FinishedTransfer } from "@/features/transfers/store/useTransfers.store"
import { unwrapDirMeta, unwrapFileMeta, unwrapParentUuid } from "@/lib/sdkUnwrap"
import { driveItemDisplayName } from "@/lib/decryption"
import { normalizeFilePathForSdk, normalizeFilePathForExpo } from "@/lib/paths"
import { wrapAbortSignalForSdk, PauseSignal, createCompositeAbortSignal, createCompositePauseSignal } from "@/lib/signals"
import { driveItemsQueryUpdateForNormalParent } from "@/features/drive/queries/useDriveItems.query"
import type { DriveItem } from "@/types"
import cache from "@/lib/cache"
import fileCache from "@/lib/fileCache"
import drive from "@/features/drive/drive"
import thumbnails from "@/lib/thumbnails"
import { EXPO_IMAGE_MANIPULATOR_SUPPORTED_EXTENSIONS, EXPO_VIDEO_SUPPORTED_EXTENSIONS } from "@/constants"
import { randomUUID } from "expo-crypto"

// Registers pause/resume event listeners on both the per-transfer and global PauseSignals,
// and queues their removal via defer() so the `run` cleanup block tears them down automatically.
function registerPauseListeners(
	id: string,
	type: Transfer["type"],
	transferPauseSignal: PauseSignal,
	globalPauseSignal: PauseSignal,
	defer: (fn: () => void) => void
): void {
	const onPause = () => {
		useTransfersStore.getState().setTransfers(prev =>
			prev.map(t =>
				t.id === id && t.type === type
					? {
							...t,
							paused: true
						}
					: t
			)
		)
	}

	const onResume = () => {
		useTransfersStore.getState().setTransfers(prev =>
			prev.map(t =>
				t.id === id && t.type === type
					? {
							...t,
							paused: false
						}
					: t
			)
		)
	}

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
	if (transfer.type === "uploadDirectory" || transfer.type === "uploadFile") {
		return transfer.errors.upload.length + transfer.errors.scan.length + transfer.errors.unknown.length
	}

	return transfer.errors.download.length + transfer.errors.scan.length + transfer.errors.unknown.length
}

// Display name for a settled transfer, matching the transfers screen row exactly:
// uploads use the local file/directory name, downloads use the drive item's decrypted name.
function finishedTransferName(transfer: Transfer): string {
	if (transfer.type === "uploadDirectory" || transfer.type === "uploadFile") {
		return transfer.localFileOrDir.name
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

	if (error instanceof Error) {
		return error.message
	}

	return String(error)
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

export type UploadParams = {
	localFileOrDir: FileSystem.File | FileSystem.Directory
	parent: AnyNormalDir
	hideProgress?: boolean
	awaitExternalCompletionBeforeMarkingAsFinished?: () => Promise<void>
	pauseSignal?: PauseSignal
	signal?: AbortSignal
	name?: string
	created?: number
	modified?: number
	mime?: string
}

export type DownloadParams = {
	item: DriveItem
	destination: FileSystem.File | FileSystem.Directory
	hideProgress?: boolean
	awaitExternalCompletionBeforeMarkingAsFinished?: () => Promise<void>
	pauseSignal?: PauseSignal
	signal?: AbortSignal
	// When true, a directory download must NOT pre-delete an existing populated destination before the
	// recursive download starts (nor delete it again on a non-abort failure). Used by the offline layer's
	// in-place tree reconcile, where the destination IS the live stored tree: the Rust downloader is
	// hash-idempotent per file, so existing healthy bytes are skipped and any failure must leave them
	// intact for the next reconcile pass. Defaults to false → the original destructive behavior is
	// preserved for every other (non-offline) caller, which downloads into a fresh/disposable destination.
	preserveDestinationOnStart?: boolean
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
		hideProgress,
		awaitExternalCompletionBeforeMarkingAsFinished,
		pauseSignal,
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
	const id = randomUUID()
	const { authedSdkClient } = await auth.getSdkClients()
	const transferAbortController = new AbortController()
	// When no caller-owned pauseSignal is supplied we allocate one here. Its inner SdkPauseSignal is a
	// uniffi (Rust Arc-backed) handle, so we must dispose() the ones we own once the transfer settles.
	const ownsTransferPauseSignal = !pauseSignal
	const transferPauseSignal = pauseSignal ?? new PauseSignal()
	const compositePauseSignal = createCompositePauseSignal(globalPauseSignal, transferPauseSignal)
	const compositeAbortSignal = signal
		? createCompositeAbortSignal(globalAbortController.signal, transferAbortController.signal, signal)
		: createCompositeAbortSignal(globalAbortController.signal, transferAbortController.signal)

	if (localFileOrDir instanceof FileSystem.Directory) {
		const result = await run(async defer => {
			// wrapAbortSignalForSdk allocates a uniffi (Rust Arc-backed) ManagedAbortSignal that must be
			// released explicitly. Hoist it so we can destroy it once the transfer settles.
			const wrappedAbortSignal = wrapAbortSignalForSdk(compositeAbortSignal)

			defer(() => {
				compositePauseSignal.dispose()
				compositeAbortSignal.dispose()
				wrappedAbortSignal.uniffiDestroy()

				if (ownsTransferPauseSignal) {
					transferPauseSignal.dispose()
				}
			})

			if (!localFileOrDir.exists) {
				throw new Error("Local directory does not exist or is empty.")
			}

			if (!hideProgress) {
				useTransfersStore.getState().setTransfers(prev => [
					...prev,
					{
						id,
						localFileOrDir,
						parent,
						type: "uploadDirectory",
						size: 0,
						knownDirectories: 0,
						knownFiles: 0,
						bytesTransferred: 0,
						startedAt: Date.now(),
						paused: false,
						errors: {
							unknown: [],
							scan: [],
							upload: []
						},
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
					}
				])

				registerPauseListeners(id, "uploadDirectory", transferPauseSignal, globalPauseSignal, defer)
			}

			let succeededUploadDirectory = false

			if (!hideProgress) {
				registerCompletionCleanup({
					id,
					type: "uploadDirectory",
					succeeded: () => succeededUploadDirectory,
					aborted: () =>
						transferAbortController.signal.aborted || globalAbortController.signal.aborted || (signal?.aborted ?? false),
					awaitExternal: awaitExternalCompletionBeforeMarkingAsFinished,
					defer
				})
			}

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
					onScanComplete(totalDirs, totalFiles, totalBytes) {
						useTransfersStore.getState().setTransfers(prev =>
							prev.map(t =>
								t.id === id && t.type === "uploadDirectory"
									? {
											...t,
											size: Number(totalBytes),
											knownDirectories: Number(totalDirs),
											knownFiles: Number(totalFiles)
										}
									: t
							)
						)
					},
					onScanErrors(errors) {
						useTransfersStore.getState().setTransfers(prev =>
							prev.map(t =>
								t.id === id && t.type === "uploadDirectory"
									? {
											...t,
											errors: {
												...t.errors,
												scan: [...t.errors.scan, ...errors]
											}
										}
									: t
							)
						)
					},
					onScanProgress(knownDirs, knownFiles, knownBytes) {
						useTransfersStore.getState().setTransfers(prev =>
							prev.map(t =>
								t.id === id && t.type === "uploadDirectory"
									? {
											...t,
											size: Number(knownBytes),
											knownDirectories: Number(knownDirs),
											knownFiles: Number(knownFiles)
										}
									: t
							)
						)
					},
					onUploadErrors(errors) {
						useTransfersStore.getState().setTransfers(prev =>
							prev.map(t =>
								t.id === id && t.type === "uploadDirectory"
									? {
											...t,
											errors: {
												...t.errors,
												upload: [...t.errors.upload, ...errors]
											}
										}
									: t
							)
						)
						// The SDK resolves Ok despite per-entry failures — thread them into the resolved
						// value (mirrors downloadCore's directory branch) so callers can act on partial
						// uploads instead of trusting resolution alone.
						transferred.errors.push(...errors)
					},
					onUploadUpdate(uploadedDirs, uploadedFiles, uploadedBytes) {
						useTransfersStore.getState().setTransfers(prev =>
							prev.map(t =>
								t.id === id && t.type === "uploadDirectory"
									? {
											...t,
											bytesTransferred: t.bytesTransferred + Number(uploadedBytes)
										}
									: t
							)
						)

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

								driveItemsQueryUpdateForNormalParent({
									parentUuid: dirParentUuid,
									updater: prev => [
										...prev.filter(
											item =>
												item.data.uuid !== unwrappedDirMeta.uuid &&
												item.data.decryptedMeta?.name.toLowerCase().trim() !==
													unwrappedDirMeta.meta?.name.toLowerCase().trim()
										),
										driveItem
									]
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

								driveItemsQueryUpdateForNormalParent({
									parentUuid: fileParentUuid,
									updater: prev => [
										...prev.filter(
											item =>
												item.data.uuid !== unwrappedFileMeta.file.uuid &&
												item.data.decryptedMeta?.name.toLowerCase().trim() !==
													unwrappedFileMeta.meta?.name.toLowerCase().trim()
										),
										driveItem
									]
								})
							}

							// TODO: Add thumbnail generation for uploaded files here once sdk exposes different type with path
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

		if (!result.success) {
			if (transferAbortController.signal.aborted || globalAbortController.signal.aborted || signal?.aborted) {
				// Don't treat abort errors as actual errors to be shown in the UI
				return null
			}

			if (hideProgress) {
				logger.error("transfers", "Directory upload failed", { id, error: result.error })
			} else {
				useTransfersStore.getState().setTransfers(prev =>
					prev.map(t =>
						t.id === id && t.type === "uploadDirectory"
							? {
									...t,
									errors: {
										...t.errors,
										...(FilenSdkError.hasInner(result.error)
											? {
													upload: [
														...t.errors.upload,
														{
															error: FilenSdkError.getInner(result.error),
															path: normalizeFilePathForSdk(localFileOrDir.uri)
														}
													]
												}
											: {
													unknown: [
														...t.errors.unknown,
														result.error instanceof Error ? result.error : new Error(String(result.error))
													]
												})
									}
								}
							: t
					)
				)

				// The error is now written to the store entry; remove the settled (errored) transfer so the
				// floating bar, foreground service and speed interval don't stay alive forever, and keep an
				// errored snapshot in the finished list. The thrown error below still surfaces to the
				// caller's alert path, independent of this removal.
				removeSettledTransfer(id, "uploadDirectory", {
					awaitExternal: awaitExternalCompletionBeforeMarkingAsFinished,
					outcome: "errored",
					errorMessage: finishedTransferErrorMessage(result.error)
				})
			}

			throw result.error
		}

		return result.data
	}

	const result = await run(async defer => {
		// wrapAbortSignalForSdk allocates a uniffi (Rust Arc-backed) ManagedAbortSignal that must be
		// released explicitly. Hoist it so we can destroy it once the transfer settles.
		const wrappedAbortSignal = wrapAbortSignalForSdk(compositeAbortSignal)

		defer(() => {
			compositePauseSignal.dispose()
			compositeAbortSignal.dispose()
			wrappedAbortSignal.uniffiDestroy()

			if (ownsTransferPauseSignal) {
				transferPauseSignal.dispose()
			}
		})

		if (!localFileOrDir.exists) {
			throw new Error("Local file does not exist.")
		}

		if (!hideProgress) {
			useTransfersStore.getState().setTransfers(prev => [
				...prev,
				{
					id,
					localFileOrDir,
					parent,
					type: "uploadFile",
					size: localFileOrDir.size,
					bytesTransferred: 0,
					startedAt: Date.now(),
					paused: false,
					errors: {
						unknown: [],
						scan: [],
						upload: []
					},
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
				}
			])

			registerPauseListeners(id, "uploadFile", transferPauseSignal, globalPauseSignal, defer)
		}

		let succeededUploadFile = false

		if (!hideProgress) {
			registerCompletionCleanup({
				id,
				type: "uploadFile",
				succeeded: () => succeededUploadFile,
				aborted: () => transferAbortController.signal.aborted || globalAbortController.signal.aborted || (signal?.aborted ?? false),
				awaitExternal: awaitExternalCompletionBeforeMarkingAsFinished,
				defer
			})
		}

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
					useTransfersStore.getState().setTransfers(prev =>
						prev.map(t =>
							t.id === id && t.type === "uploadFile"
								? {
										...t,
										bytesTransferred: t.bytesTransferred + Number(uploadedBytes)
									}
								: t
						)
					)
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
		if (transferAbortController.signal.aborted || globalAbortController.signal.aborted || signal?.aborted) {
			// Don't treat abort errors as actual errors to be shown in the UI
			return null
		}

		if (hideProgress) {
			logger.error("transfers", "File upload failed", { id, error: result.error })
		} else {
			useTransfersStore.getState().setTransfers(prev =>
				prev.map(t =>
					t.id === id && t.type === "uploadFile"
						? {
								...t,
								errors: {
									...t.errors,
									...(FilenSdkError.hasInner(result.error)
										? {
												upload: [
													...t.errors.upload,
													{
														error: FilenSdkError.getInner(result.error),
														path: normalizeFilePathForSdk(localFileOrDir.uri)
													}
												]
											}
										: {
												unknown: [
													...t.errors.unknown,
													result.error instanceof Error ? result.error : new Error(String(result.error))
												]
											})
								}
							}
						: t
				)
			)

			// The error is now written to the store entry; remove the settled (errored) transfer so the
			// floating bar, foreground service and speed interval don't stay alive forever, and keep an
			// errored snapshot in the finished list. The thrown error below still surfaces to the
			// caller's alert path, independent of this removal.
			removeSettledTransfer(id, "uploadFile", {
				awaitExternal: awaitExternalCompletionBeforeMarkingAsFinished,
				outcome: "errored",
				errorMessage: finishedTransferErrorMessage(result.error)
			})
		}

		throw result.error
	}

	const unwrappedFileMeta = unwrapFileMeta(result.data)

	if (!unwrappedFileMeta.shared) {
		const driveItem = {
			type: "file" as const,
			data: {
				...unwrappedFileMeta.file,
				decryptedMeta: unwrappedFileMeta.meta,
				undecryptable: unwrappedFileMeta.meta === null
			}
		}

		// Mirror the new file into the PersistentMap caches so downstream
		// reads (useFileUrlQuery, drive item info, etc.) work without a
		// manual refetch. Matches what useDriveItems.query.ts:fetchData()
		// does inline on each fetch.
		cache.cacheNewFile(result.data, driveItem)

		driveItemsQueryUpdateForNormalParent({
			parentUuid: parent.inner[0].uuid,
			updater: prev => [
				...prev.filter(
					item =>
						item.data.uuid !== result.data.uuid &&
						item.data.decryptedMeta?.name.toLowerCase().trim() !== unwrappedFileMeta.meta?.name.toLowerCase().trim()
				),
				driveItem
			]
		})
	}

	const uploadedFileName = name ?? localFileOrDir.name ?? ""
	const ext = FileSystem.Paths.extname(uploadedFileName).toLowerCase()

	if (EXPO_IMAGE_MANIPULATOR_SUPPORTED_EXTENSIONS.has(ext) || EXPO_VIDEO_SUPPORTED_EXTENSIONS.has(ext)) {
		await thumbnails
			.generateFromLocalFile({
				localPath: normalizeFilePathForExpo(localFileOrDir.uri),
				uuid: result.data.uuid,
				name: uploadedFileName,
				signal: compositeAbortSignal
			})
			.catch(err => {
				logger.warn("transfers", "Thumbnail generation failed after upload", { uuid: result.data.uuid, name: uploadedFileName, error: err })
			})
	}

	return {
		files: [result.data],
		directories: []
	}
}

// Performs a download against the SDK with full progress tracking. Mirrors uploadCore.
export async function downloadCore(
	globalAbortController: AbortController,
	globalPauseSignal: PauseSignal,
	{
		item,
		destination,
		hideProgress,
		awaitExternalCompletionBeforeMarkingAsFinished,
		pauseSignal,
		signal,
		preserveDestinationOnStart
	}: DownloadParams
): Promise<
	| {
			files: (Omit<FileWithPath, "file"> & {
				file: File | SharedFile
			})[]
			directories: DirWithPath[]
			errors: DownloadError[]
			scanErrors: FilenSdkErrorInterface[]
	  }
	| {
			files: (Omit<FileWithPath, "file"> & {
				file: File | SharedFile
			})[]
			directories: DirWithPath[]
	  }
	| null
> {
	const id = randomUUID()
	const { authedSdkClient } = await auth.getSdkClients()
	const transferAbortController = new AbortController()
	// When no caller-owned pauseSignal is supplied we allocate one here. Its inner SdkPauseSignal is a
	// uniffi (Rust Arc-backed) handle, so we must dispose() the ones we own once the transfer settles.
	const ownsTransferPauseSignal = !pauseSignal
	const transferPauseSignal = pauseSignal ?? new PauseSignal()
	const compositePauseSignal = createCompositePauseSignal(globalPauseSignal, transferPauseSignal)
	const compositeAbortSignal = signal
		? createCompositeAbortSignal(globalAbortController.signal, transferAbortController.signal, signal)
		: createCompositeAbortSignal(globalAbortController.signal, transferAbortController.signal)

	if (item.type === "directory" || item.type === "sharedDirectory" || item.type === "sharedRootDirectory") {
		const result = await run(async defer => {
			// wrapAbortSignalForSdk allocates a uniffi (Rust Arc-backed) ManagedAbortSignal that must be
			// released explicitly. Hoist it so we can destroy it once the transfer settles.
			const wrappedAbortSignal = wrapAbortSignalForSdk(compositeAbortSignal)

			defer(() => {
				compositePauseSignal.dispose()
				compositeAbortSignal.dispose()
				wrappedAbortSignal.uniffiDestroy()

				if (ownsTransferPauseSignal) {
					transferPauseSignal.dispose()
				}
			})

			if (destination instanceof FileSystem.File) {
				throw new Error("Destination must be a directory for directory downloads.")
			}

			if (!hideProgress) {
				useTransfersStore.getState().setTransfers(prev => [
					...prev,
					{
						id,
						item,
						type: "downloadDirectory",
						size: 0,
						knownDirectories: 0,
						knownFiles: 0,
						bytesTransferred: 0,
						startedAt: Date.now(),
						paused: false,
						directoryQueryProgress: {
							totalBytes: 0,
							bytesTransferred: 0
						},
						errors: {
							unknown: [],
							scan: [],
							download: []
						},
						destination,
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
					}
				])

				registerPauseListeners(id, "downloadDirectory", transferPauseSignal, globalPauseSignal, defer)
			}

			let succeededDownloadDirectory = false

			if (!hideProgress) {
				registerCompletionCleanup({
					id,
					type: "downloadDirectory",
					succeeded: () => succeededDownloadDirectory,
					aborted: () =>
						transferAbortController.signal.aborted || globalAbortController.signal.aborted || (signal?.aborted ?? false),
					awaitExternal: awaitExternalCompletionBeforeMarkingAsFinished,
					defer
				})
			}

			const transferred: {
				files: (Omit<FileWithPath, "file"> & { file: File | SharedFile })[]
				directories: DirWithPath[]
				errors: DownloadError[]
				// SDK-side tree-scan errors. A failed scan silently DROPS the affected subtree from
				// the download set while the call still resolves Ok — callers that verify
				// completeness (the offline layer) need these to tell "scan-degraded" from "done".
				scanErrors: FilenSdkErrorInterface[]
			} = {
				files: [],
				directories: [],
				errors: [],
				scanErrors: []
			}

			const targetDir: AnyDirWithContext = (() => {
				switch (item.type) {
					case "directory": {
						return new AnyDirWithContext.Normal(new AnyNormalDir.Dir(item.data))
					}

					case "sharedDirectory": {
						const parentUuid = unwrapParentUuid(item.data.inner.parent)

						if (!parentUuid) {
							throw new Error("Shared directory is missing parent information.")
						}

						const parentDirFromCache = cache.directoryUuidToAnySharedDirWithContext.get(parentUuid)

						if (!parentDirFromCache) {
							throw new Error("Parent directory of shared directory not found in cache.")
						}

						// Target the shared directory ITSELF (item.data), borrowing only the shareInfo from the
						// cached parent — mirrors offline.ts findParentAnyDirWithContext. Wrapping the parent's
						// AnySharedDirWithContext directly would download the PARENT's (larger) tree instead of
						// this child directory.
						return new AnyDirWithContext.Shared(
							AnySharedDirWithContext.new({
								dir: new AnySharedDir.Dir(item.data),
								shareInfo: parentDirFromCache.shareInfo
							})
						)
					}

					case "sharedRootDirectory": {
						return new AnyDirWithContext.Shared(
							AnySharedDirWithContext.new({
								dir: new AnySharedDir.Root(item.data),
								shareInfo: item.data.sharingRole
							})
						)
					}
				}
			})()

			if (!preserveDestinationOnStart && destination.exists) {
				destination.delete()
			}

			await authedSdkClient.downloadDirRecursively(
				normalizeFilePathForSdk(destination.uri),
				{
					onDownloadErrors(errors) {
						useTransfersStore.getState().setTransfers(prev =>
							prev.map(t =>
								t.id === id && t.type === "downloadDirectory"
									? {
											...t,
											errors: {
												...t.errors,
												download: [...t.errors.download, ...errors]
											}
										}
									: t
							)
						)
						transferred.errors.push(...errors)
					},
					onDownloadUpdate(downloadedDirs, downloadedFiles, downloadedBytes) {
						for (const downloadedDir of downloadedDirs) {
							transferred.directories.push(downloadedDir)
						}

						for (const downloadedFile of downloadedFiles) {
							transferred.files.push(downloadedFile)
						}

						useTransfersStore.getState().setTransfers(prev =>
							prev.map(t =>
								t.id === id && t.type === "downloadDirectory"
									? {
											...t,
											bytesTransferred: t.bytesTransferred + Number(downloadedBytes)
										}
									: t
							)
						)
					},
					onQueryDownloadProgress(knownBytes, totalBytes) {
						useTransfersStore.getState().setTransfers(prev =>
							prev.map(t =>
								t.id === id && t.type === "downloadDirectory"
									? {
											...t,
											directoryQueryProgress: {
												bytesTransferred: Number(knownBytes),
												totalBytes: Number(totalBytes)
											}
										}
									: t
							)
						)
					},
					onScanComplete(totalDirs, totalFiles, totalBytes) {
						useTransfersStore.getState().setTransfers(prev =>
							prev.map(t =>
								t.id === id && t.type === "downloadDirectory"
									? {
											...t,
											size: Number(totalBytes),
											knownDirectories: Number(totalDirs),
											knownFiles: Number(totalFiles)
										}
									: t
							)
						)
					},
					onScanErrors(errors) {
						transferred.scanErrors.push(...errors)

						useTransfersStore.getState().setTransfers(prev =>
							prev.map(t =>
								t.id === id && t.type === "downloadDirectory"
									? {
											...t,
											errors: {
												...t.errors,
												scan: [...t.errors.scan, ...errors]
											}
										}
									: t
							)
						)
					},
					onScanProgress(knownDirs, knownFiles, knownBytes) {
						useTransfersStore.getState().setTransfers(prev =>
							prev.map(t =>
								t.id === id && t.type === "downloadDirectory"
									? {
											...t,
											size: Number(knownBytes),
											knownDirectories: Number(knownDirs),
											knownFiles: Number(knownFiles)
										}
									: t
							)
						)
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

			if (transferAbortController.signal.aborted || globalAbortController.signal.aborted || signal?.aborted) {
				// Don't treat abort errors as actual errors to be shown in the UI
				return null
			}

			if (hideProgress) {
				logger.error("transfers", "Directory download failed", { id, error: result.error })
			} else {
				useTransfersStore.getState().setTransfers(prev =>
					prev.map(t =>
						t.id === id && t.type === "downloadDirectory"
							? {
									...t,
									errors: {
										...t.errors,
										...(FilenSdkError.hasInner(result.error)
											? {
													download: [
														...t.errors.download,
														{
															path: normalizeFilePathForSdk(destination.uri),
															error: FilenSdkError.getInner(result.error)
														}
													]
												}
											: {
													unknown: [
														...t.errors.unknown,
														result.error instanceof Error ? result.error : new Error(String(result.error))
													]
												})
									}
								}
							: t
					)
				)

				// The error is now written to the store entry; remove the settled (errored) transfer so the
				// floating bar, foreground service and speed interval don't stay alive forever, and keep an
				// errored snapshot in the finished list. The thrown error below still surfaces to the
				// caller's alert path, independent of this removal.
				removeSettledTransfer(id, "downloadDirectory", {
					awaitExternal: awaitExternalCompletionBeforeMarkingAsFinished,
					outcome: "errored",
					errorMessage: finishedTransferErrorMessage(result.error)
				})
			}

			throw result.error
		}

		return result.data
	}

	const result = await run(async defer => {
		// wrapAbortSignalForSdk allocates a uniffi (Rust Arc-backed) ManagedAbortSignal that must be
		// released explicitly. Allocate it lazily (cache hits below never reach the SDK download) and
		// destroy whatever we allocated once the transfer settles.
		let wrappedAbortSignal: ReturnType<typeof wrapAbortSignalForSdk> | null = null

		defer(() => {
			compositePauseSignal.dispose()
			compositeAbortSignal.dispose()
			wrappedAbortSignal?.uniffiDestroy()

			if (ownsTransferPauseSignal) {
				transferPauseSignal.dispose()
			}
		})

		if (!(destination instanceof FileSystem.File)) {
			throw new Error("Destination must be a file for file downloads.")
		}

		const remoteAnyFile: AnyFile = (() => {
			switch (item.type) {
				case "file": {
					return new AnyFile.File(item.data)
				}

				case "sharedFile":
				case "sharedRootFile": {
					return new AnyFile.Shared(item.data)
				}
			}
		})()

		if (!hideProgress) {
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
				}
			])

			registerPauseListeners(id, "downloadFile", transferPauseSignal, globalPauseSignal, defer)
		}

		let succeededDownloadFile = false

		if (!hideProgress) {
			registerCompletionCleanup({
				id,
				type: "downloadFile",
				succeeded: () => succeededDownloadFile,
				aborted: () => transferAbortController.signal.aborted || globalAbortController.signal.aborted || (signal?.aborted ?? false),
				awaitExternal: awaitExternalCompletionBeforeMarkingAsFinished,
				defer
			})
		}

		const cachedOrOfflineFile = await run(async () => {
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

			if (!hideProgress) {
				useTransfersStore.getState().setTransfers(prev =>
					prev.map(t =>
						t.id === id && t.type === "downloadFile"
							? {
									...t,
									bytesTransferred: Number(item.data.size)
								}
							: t
					)
				)
			}
		} else {
			wrappedAbortSignal = wrapAbortSignalForSdk(compositeAbortSignal)

			await authedSdkClient.downloadFileToPath(
				remoteAnyFile,
				normalizeFilePathForSdk(destination.uri),
				{
					onUpdate(downloadedBytes) {
						useTransfersStore.getState().setTransfers(prev =>
							prev.map(t =>
								t.id === id && t.type === "downloadFile"
									? {
											...t,
											bytesTransferred: t.bytesTransferred + Number(downloadedBytes)
										}
									: t
							)
						)
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

		const transferred: Awaited<ReturnType<typeof downloadCore>> = {
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

		if (transferAbortController.signal.aborted || globalAbortController.signal.aborted || signal?.aborted) {
			// Don't treat abort errors as actual errors to be shown in the UI
			return null
		}

		if (hideProgress) {
			logger.error("transfers", "File download failed", { id, error: result.error })
		} else {
			useTransfersStore.getState().setTransfers(prev =>
				prev.map(t =>
					t.id === id && t.type === "downloadFile"
						? {
								...t,
								errors: {
									...t.errors,
									...(FilenSdkError.hasInner(result.error)
										? {
												download: [
													...t.errors.download,
													{
														path: normalizeFilePathForSdk(destination.uri),
														error: FilenSdkError.getInner(result.error)
													}
												]
											}
										: {
												unknown: [
													...t.errors.unknown,
													result.error instanceof Error ? result.error : new Error(String(result.error))
												]
											})
								}
							}
						: t
				)
			)

			// The error is now written to the store entry; remove the settled (errored) transfer so the
			// floating bar, foreground service and speed interval don't stay alive forever, and keep an
			// errored snapshot in the finished list. The thrown error below still surfaces to the
			// caller's alert path, independent of this removal.
			removeSettledTransfer(id, "downloadFile", {
				awaitExternal: awaitExternalCompletionBeforeMarkingAsFinished,
				outcome: "errored",
				errorMessage: finishedTransferErrorMessage(result.error)
			})
		}

		throw result.error
	}

	return result.data
}
