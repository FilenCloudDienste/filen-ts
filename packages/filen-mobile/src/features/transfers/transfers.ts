import auth from "@/lib/auth"
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
	type SharedFile
} from "@filen/sdk-rs"
import useTransfersStore from "@/features/transfers/store/useTransfers.store"
import { unwrapDirMeta, unwrapFileMeta, unwrapParentUuid } from "@/lib/sdkUnwrap"
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

class Transfers {
	private globalAbortController = new AbortController()
	private globalPauseSignal = new PauseSignal()

	public cancelAll(): void {
		this.globalAbortController.abort()
		this.globalAbortController = new AbortController()
		// Free the old pause signal's SDK handle before replacing it — uniffi handles are not
		// GC'd. Safe here: cancelAll() has aborted all in-flight transfers, and each transfer
		// drives the SDK via its own composite signal (disposed on settle), only attaching JS
		// listeners to this one — so nothing still in flight reads the freed handle.
		this.globalPauseSignal.dispose()
		this.globalPauseSignal = new PauseSignal()
	}

	public pauseAll(): void {
		this.globalPauseSignal.pause()
	}

	public resumeAll(): void {
		this.globalPauseSignal.resume()
	}

	/** Returns uploaded items as the result. If null, the transfer has been cancelled. */
	public async upload({
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
	}: {
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
	}): Promise<{
		files: File[]
		directories: Dir[]
	} | null> {
		const id = randomUUID()
		const { authedSdkClient } = await auth.getSdkClients()
		const transferAbortController = new AbortController()
		// When no caller-owned pauseSignal is supplied we allocate one here. Its inner SdkPauseSignal is a
		// uniffi (Rust Arc-backed) handle, so we must dispose() the ones we own once the transfer settles.
		const ownsTransferPauseSignal = !pauseSignal
		const transferPauseSignal = pauseSignal ?? new PauseSignal()
		const globalAbortController = this.globalAbortController
		const globalPauseSignal = this.globalPauseSignal
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

					const transferPauseSignalOnPause = () => {
						useTransfersStore.getState().setTransfers(prev =>
							prev.map(t =>
								t.id === id && t.type === "uploadDirectory"
									? {
											...t,
											paused: true
										}
									: t
							)
						)
					}

					const transferPauseSignalOnResume = () => {
						useTransfersStore.getState().setTransfers(prev =>
							prev.map(t =>
								t.id === id && t.type === "uploadDirectory"
									? {
											...t,
											paused: false
										}
									: t
							)
						)
					}

					transferPauseSignal.addEventListener("pause", transferPauseSignalOnPause)
					transferPauseSignal.addEventListener("resume", transferPauseSignalOnResume)

					globalPauseSignal.addEventListener("pause", transferPauseSignalOnPause)
					globalPauseSignal.addEventListener("resume", transferPauseSignalOnResume)

					defer(() => {
						transferPauseSignal.removeEventListener("pause", transferPauseSignalOnPause)
						transferPauseSignal.removeEventListener("resume", transferPauseSignalOnResume)

						globalPauseSignal.removeEventListener("pause", transferPauseSignalOnPause)
						globalPauseSignal.removeEventListener("resume", transferPauseSignalOnResume)
					})
				}

				let succeededUploadDirectory = false

				if (!hideProgress) {
					defer(() => {
						const aborted =
							transferAbortController.signal.aborted ||
							globalAbortController.signal.aborted ||
							signal?.aborted

						if (!succeededUploadDirectory && !aborted) {
							return
						}

						;(awaitExternalCompletionBeforeMarkingAsFinished
							? awaitExternalCompletionBeforeMarkingAsFinished()
							: Promise.resolve()
						)
							.then(() => {
								useTransfersStore
									.getState()
									.setTransfers(prev => prev.filter(t => !(t.id === id && t.type === "uploadDirectory")))
							})
							.catch(console.error)
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
				} = {
					files: [],
					directories: []
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

				if (!hideProgress) {
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

				const transferPauseSignalOnPause = () => {
					useTransfersStore.getState().setTransfers(prev =>
						prev.map(t =>
							t.id === id && t.type === "uploadFile"
								? {
										...t,
										paused: true
									}
								: t
						)
					)
				}

				const transferPauseSignalOnResume = () => {
					useTransfersStore.getState().setTransfers(prev =>
						prev.map(t =>
							t.id === id && t.type === "uploadFile"
								? {
										...t,
										paused: false
									}
								: t
						)
					)
				}

				transferPauseSignal.addEventListener("pause", transferPauseSignalOnPause)
				transferPauseSignal.addEventListener("resume", transferPauseSignalOnResume)

				globalPauseSignal.addEventListener("pause", transferPauseSignalOnPause)
				globalPauseSignal.addEventListener("resume", transferPauseSignalOnResume)

				defer(() => {
					transferPauseSignal.removeEventListener("pause", transferPauseSignalOnPause)
					transferPauseSignal.removeEventListener("resume", transferPauseSignalOnResume)

					globalPauseSignal.removeEventListener("pause", transferPauseSignalOnPause)
					globalPauseSignal.removeEventListener("resume", transferPauseSignalOnResume)
				})
			}

			let succeededUploadFile = false

			if (!hideProgress) {
				defer(() => {
					const aborted =
						transferAbortController.signal.aborted ||
						globalAbortController.signal.aborted ||
						signal?.aborted

					if (!succeededUploadFile && !aborted) {
						return
					}

					;(awaitExternalCompletionBeforeMarkingAsFinished ? awaitExternalCompletionBeforeMarkingAsFinished() : Promise.resolve())
						.then(() => {
							useTransfersStore.getState().setTransfers(prev => prev.filter(t => !(t.id === id && t.type === "uploadFile")))
						})
						.catch(console.error)
				})
			}

			const transferred = await authedSdkClient.uploadFile(
				{
					parent,
					name: name ?? localFileOrDir.name ?? undefined,
					created: created ? BigInt(created) : undefined,
					modified: modified ? BigInt(modified) : undefined,
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

			if (!hideProgress) {
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
					console.error("[Transfers] Thumbnail generation failed, deferring", err)
				})
		}

		return {
			files: [result.data],
			directories: []
		}
	}

	/** Returns downloaded items as the result. If null, the transfer has been cancelled. */
	public async download({
		item,
		destination,
		hideProgress,
		awaitExternalCompletionBeforeMarkingAsFinished,
		pauseSignal,
		signal
	}: {
		item: DriveItem
		destination: FileSystem.File | FileSystem.Directory
		hideProgress?: boolean
		awaitExternalCompletionBeforeMarkingAsFinished?: () => Promise<void>
		pauseSignal?: PauseSignal
		signal?: AbortSignal
	}): Promise<{
		files: (Omit<FileWithPath, "file"> & {
			file: File | SharedFile
		})[]
		directories: DirWithPath[]
	} | null> {
		const id = randomUUID()
		const { authedSdkClient } = await auth.getSdkClients()
		const transferAbortController = new AbortController()
		// When no caller-owned pauseSignal is supplied we allocate one here. Its inner SdkPauseSignal is a
		// uniffi (Rust Arc-backed) handle, so we must dispose() the ones we own once the transfer settles.
		const ownsTransferPauseSignal = !pauseSignal
		const transferPauseSignal = pauseSignal ?? new PauseSignal()
		const globalAbortController = this.globalAbortController
		const globalPauseSignal = this.globalPauseSignal
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

					const transferPauseSignalOnPause = () => {
						useTransfersStore.getState().setTransfers(prev =>
							prev.map(t =>
								t.id === id && t.type === "downloadDirectory"
									? {
											...t,
											paused: true
										}
									: t
							)
						)
					}

					const transferPauseSignalOnResume = () => {
						useTransfersStore.getState().setTransfers(prev =>
							prev.map(t =>
								t.id === id && t.type === "downloadDirectory"
									? {
											...t,
											paused: false
										}
									: t
							)
						)
					}

					transferPauseSignal.addEventListener("pause", transferPauseSignalOnPause)
					transferPauseSignal.addEventListener("resume", transferPauseSignalOnResume)

					globalPauseSignal.addEventListener("pause", transferPauseSignalOnPause)
					globalPauseSignal.addEventListener("resume", transferPauseSignalOnResume)

					defer(() => {
						transferPauseSignal.removeEventListener("pause", transferPauseSignalOnPause)
						transferPauseSignal.removeEventListener("resume", transferPauseSignalOnResume)

						globalPauseSignal.removeEventListener("pause", transferPauseSignalOnPause)
						globalPauseSignal.removeEventListener("resume", transferPauseSignalOnResume)
					})
				}

				let succeededDownloadDirectory = false

				if (!hideProgress) {
					defer(() => {
						const aborted =
							transferAbortController.signal.aborted ||
							globalAbortController.signal.aborted ||
							signal?.aborted

						if (!succeededDownloadDirectory && !aborted) {
							return
						}

						;(awaitExternalCompletionBeforeMarkingAsFinished
							? awaitExternalCompletionBeforeMarkingAsFinished()
							: Promise.resolve()
						)
							.then(() => {
								useTransfersStore
									.getState()
									.setTransfers(prev => prev.filter(t => !(t.id === id && t.type === "downloadDirectory")))
							})
							.catch(console.error)
					})
				}

				const transferred: Awaited<ReturnType<Transfers["download"]>> = {
					files: [],
					directories: []
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

							return new AnyDirWithContext.Shared(parentDirFromCache)
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

				if (destination.exists) {
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
				if (destination.exists) {
					destination.delete()
				}

				if (transferAbortController.signal.aborted || globalAbortController.signal.aborted || signal?.aborted) {
					// Don't treat abort errors as actual errors to be shown in the UI
					return null
				}

				if (!hideProgress) {
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

				const transferPauseSignalOnPause = () => {
					useTransfersStore.getState().setTransfers(prev =>
						prev.map(t =>
							t.id === id && t.type === "downloadFile"
								? {
										...t,
										paused: true
									}
								: t
						)
					)
				}

				const transferPauseSignalOnResume = () => {
					useTransfersStore.getState().setTransfers(prev =>
						prev.map(t =>
							t.id === id && t.type === "downloadFile"
								? {
										...t,
										paused: false
									}
								: t
						)
					)
				}

				transferPauseSignal.addEventListener("pause", transferPauseSignalOnPause)
				transferPauseSignal.addEventListener("resume", transferPauseSignalOnResume)

				globalPauseSignal.addEventListener("pause", transferPauseSignalOnPause)
				globalPauseSignal.addEventListener("resume", transferPauseSignalOnResume)

				defer(() => {
					transferPauseSignal.removeEventListener("pause", transferPauseSignalOnPause)
					transferPauseSignal.removeEventListener("resume", transferPauseSignalOnResume)

					globalPauseSignal.removeEventListener("pause", transferPauseSignalOnPause)
					globalPauseSignal.removeEventListener("resume", transferPauseSignalOnResume)
				})
			}

			let succeededDownloadFile = false

			if (!hideProgress) {
				defer(() => {
					const aborted =
						transferAbortController.signal.aborted ||
						globalAbortController.signal.aborted ||
						signal?.aborted

					if (!succeededDownloadFile && !aborted) {
						return
					}

					;(awaitExternalCompletionBeforeMarkingAsFinished ? awaitExternalCompletionBeforeMarkingAsFinished() : Promise.resolve())
						.then(() => {
							useTransfersStore.getState().setTransfers(prev => prev.filter(t => !(t.id === id && t.type === "downloadFile")))
						})
						.catch(console.error)
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
				cachedOrOfflineFile.data.copy(destination)

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

			const transferred: Awaited<ReturnType<Transfers["download"]>> = {
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

			if (!hideProgress) {
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
			}

			throw result.error
		}

		return result.data
	}
}

const transfers = new Transfers()

export default transfers
