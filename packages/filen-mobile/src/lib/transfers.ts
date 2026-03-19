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
import useTransfersStore from "@/stores/useTransfers.store"
import {
	normalizeFilePathForSdk,
	unwrapDirMeta,
	unwrapFileMeta,
	wrapAbortSignalForSdk,
	PauseSignal,
	createCompositeAbortSignal,
	createCompositePauseSignal,
	unwrapParentUuid
} from "@/lib/utils"
import { driveItemsQueryUpdate } from "@/queries/useDriveItems.query"
import type { DriveItem } from "@/types"
import cache from "@/lib/cache"
import fileCache from "@/lib/fileCache"

class Transfers {
	private globalAbortController = new AbortController()
	private globalPauseSignal = new PauseSignal()
	private readonly activeUploadIds = new Set<string>()
	private readonly activeUploadUris = new Set<string>()
	private readonly activeDownloadKeys = new Set<string>()

	public cancelAll(): void {
		this.globalAbortController.abort()
		this.globalAbortController = new AbortController()
		this.globalPauseSignal = new PauseSignal()
		this.activeUploadIds.clear()
		this.activeUploadUris.clear()
		this.activeDownloadKeys.clear()
	}

	public pauseAll(): void {
		this.globalPauseSignal.pause()
	}

	public resumeAll(): void {
		this.globalPauseSignal.resume()
	}

	public async upload({
		id,
		localFileOrDir,
		parent,
		hideProgress,
		awaitExternalCompletionBeforeMarkingAsFinished,
		abortController,
		pauseSignal
	}: {
		id: string
		localFileOrDir: FileSystem.File | FileSystem.Directory
		parent: AnyNormalDir
		hideProgress?: boolean
		awaitExternalCompletionBeforeMarkingAsFinished?: () => Promise<void>
		abortController?: AbortController
		pauseSignal?: PauseSignal
	}): Promise<{
		files: File[]
		directories: Dir[]
	}> {
		if (this.activeUploadIds.has(id) || this.activeUploadUris.has(localFileOrDir.uri)) {
			throw new Error("A transfer with the same ID or local URI is already in progress.")
		}

		this.activeUploadIds.add(id)
		this.activeUploadUris.add(localFileOrDir.uri)

		const { authedSdkClient } = await auth.getSdkClients()
		const transferAbortController = abortController ?? new AbortController()
		const transferPauseSignal = pauseSignal ?? new PauseSignal()
		const compositePauseSignal = createCompositePauseSignal(this.globalPauseSignal, transferPauseSignal)
		const compositeAbortSignal = createCompositeAbortSignal(this.globalAbortController.signal, transferAbortController.signal)

		if (localFileOrDir instanceof FileSystem.Directory) {
			const result = await run(async defer => {
				defer(() => {
					compositePauseSignal.dispose()
					compositeAbortSignal.dispose()

					this.activeUploadIds.delete(id)
					this.activeUploadUris.delete(localFileOrDir.uri)
				})

				if (parent.tag === AnyNormalDir_Tags.Root) {
					throw new Error("Cannot upload to root directory.")
				}

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
							abortController: transferAbortController,
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
				}

				if (!hideProgress) {
					defer(() => {
						;(awaitExternalCompletionBeforeMarkingAsFinished
							? awaitExternalCompletionBeforeMarkingAsFinished()
							: Promise.resolve()
						)
							.then(() => {
								useTransfersStore.getState().setTransfers(prev =>
									prev.map(t =>
										t.id === id
											? {
													...t,
													finishedAt: Date.now()
												}
											: t
									)
								)
							})
							.catch(console.error)
					})
				}

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
									t.id === id
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
									driveItemsQueryUpdate({
										params: {
											path: {
												type: "drive",
												uuid: dirParentUuid
											}
										},
										updater: prev => [
											...prev.filter(item => item.data.uuid !== uploadedDir.uuid),
											{
												type: "directory",
												data: {
													...unwrappedDirMeta.dir,
													size: 0n,
													decryptedMeta: unwrappedDirMeta.meta
												}
											}
										]
									})
								}
							}

							for (const uploadedFile of uploadedFiles) {
								transferred.files.push(uploadedFile)

								const unwrappedFileMeta = unwrapFileMeta(uploadedFile)
								const fileParentUuid = unwrapParentUuid(uploadedFile.parent)

								if (!unwrappedFileMeta.shared && fileParentUuid) {
									driveItemsQueryUpdate({
										params: {
											path: {
												type: "drive",
												uuid: fileParentUuid
											}
										},
										updater: prev => [
											...prev.filter(item => item.data.uuid !== uploadedFile.uuid),
											{
												type: "file",
												data: {
													...unwrappedFileMeta.file,
													decryptedMeta: unwrappedFileMeta.meta
												}
											}
										]
									})
								}
							}
						}
					},
					parent.inner[0],
					ManagedFuture.new({
						pauseSignal: compositePauseSignal.getSignal(),
						abortSignal: wrapAbortSignalForSdk(compositeAbortSignal)
					}),
					{
						signal: compositeAbortSignal
					}
				)

				return transferred
			})

			if (!result.success) {
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

		// TODO: Add metadata timestamps before upload to copied file
		const result = await run(async defer => {
			defer(() => {
				compositePauseSignal.dispose()
				compositeAbortSignal.dispose()

				this.activeUploadIds.delete(id)
				this.activeUploadUris.delete(localFileOrDir.uri)
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
						abortController: transferAbortController,
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
			}

			if (!hideProgress) {
				defer(() => {
					;(awaitExternalCompletionBeforeMarkingAsFinished ? awaitExternalCompletionBeforeMarkingAsFinished() : Promise.resolve())
						.then(() => {
							useTransfersStore.getState().setTransfers(prev =>
								prev.map(t =>
									t.id === id
										? {
												...t,
												finishedAt: Date.now()
											}
										: t
								)
							)
						})
						.catch(console.error)
				})
			}

			const transferred = await authedSdkClient.uploadFile(
				parent,
				normalizeFilePathForSdk(localFileOrDir.uri),
				{
					onUpdate(uploadedBytes) {
						useTransfersStore.getState().setTransfers(prev =>
							prev.map(t =>
								t.id === id
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
					abortSignal: wrapAbortSignalForSdk(compositeAbortSignal)
				}),
				{
					signal: compositeAbortSignal
				}
			)

			return transferred
		})

		if (!result.success) {
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
			driveItemsQueryUpdate({
				params: {
					path: {
						type: "drive",
						uuid: parent.inner[0].uuid
					}
				},
				updater: prev => [
					...prev.filter(item => item.data.uuid !== result.data.uuid),
					{
						type: "file",
						data: {
							...unwrappedFileMeta.file,
							decryptedMeta: unwrappedFileMeta.meta
						}
					}
				]
			})
		}

		return {
			files: [result.data],
			directories: []
		}
	}

	public async download({
		itemUuid,
		item,
		destination,
		hideProgress,
		awaitExternalCompletionBeforeMarkingAsFinished,
		abortController,
		pauseSignal
	}: {
		itemUuid: string
		item: DriveItem
		destination: FileSystem.File | FileSystem.Directory
		hideProgress?: boolean
		awaitExternalCompletionBeforeMarkingAsFinished?: () => Promise<void>
		abortController?: AbortController
		pauseSignal?: PauseSignal
	}): Promise<{
		files: (Omit<FileWithPath, "file"> & {
			file: File | SharedFile
		})[]
		directories: DirWithPath[]
	}> {
		const downloadKey = `${itemUuid}:${destination.uri}`

		if (this.activeDownloadKeys.has(downloadKey)) {
			throw new Error("A transfer with the same ID and destination URI is already in progress.")
		}

		this.activeDownloadKeys.add(downloadKey)

		const { authedSdkClient } = await auth.getSdkClients()
		const transferAbortController = abortController ?? new AbortController()
		const transferPauseSignal = pauseSignal ?? new PauseSignal()
		const compositePauseSignal = createCompositePauseSignal(this.globalPauseSignal, transferPauseSignal)
		const compositeAbortSignal = createCompositeAbortSignal(this.globalAbortController.signal, transferAbortController.signal)

		if (item.type === "directory" || item.type === "sharedDirectory" || item.type === "sharedRootDirectory") {
			const result = await run(async defer => {
				defer(() => {
					compositePauseSignal.dispose()
					compositeAbortSignal.dispose()

					this.activeDownloadKeys.delete(downloadKey)
				})

				if (destination instanceof FileSystem.File) {
					throw new Error("Destination must be a directory for directory downloads.")
				}

				if (!hideProgress) {
					useTransfersStore.getState().setTransfers(prev => [
						...prev,
						{
							id: itemUuid,
							item: item.data,
							type: "downloadDirectory",
							size: 0,
							knownDirectories: 0,
							knownFiles: 0,
							bytesTransferred: 0,
							startedAt: Date.now(),
							abortController: transferAbortController,
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
				}

				if (!hideProgress) {
					defer(() => {
						;(awaitExternalCompletionBeforeMarkingAsFinished
							? awaitExternalCompletionBeforeMarkingAsFinished()
							: Promise.resolve()
						)
							.then(() => {
								useTransfersStore.getState().setTransfers(prev =>
									prev.map(t =>
										t.id === itemUuid
											? {
													...t,
													finishedAt: Date.now()
												}
											: t
									)
								)
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

				if (destination.exists) {
					destination.delete()
				}

				await authedSdkClient.downloadDirRecursively(
					normalizeFilePathForSdk(destination.uri),
					{
						onDownloadErrors(errors) {
							useTransfersStore.getState().setTransfers(prev =>
								prev.map(t =>
									t.id === itemUuid && t.type === "downloadDirectory"
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
									t.id === itemUuid
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
									t.id === itemUuid && t.type === "downloadDirectory"
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
									t.id === itemUuid && t.type === "downloadDirectory"
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
									t.id === itemUuid && t.type === "downloadDirectory"
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
									t.id === itemUuid && t.type === "downloadDirectory"
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
						abortSignal: wrapAbortSignalForSdk(compositeAbortSignal)
					}),
					{
						signal: compositeAbortSignal
					}
				)

				return transferred
			})

			if (!result.success) {
				if (!hideProgress) {
					useTransfersStore.getState().setTransfers(prev =>
						prev.map(t =>
							t.id === itemUuid && t.type === "downloadDirectory"
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
			defer(() => {
				compositePauseSignal.dispose()
				compositeAbortSignal.dispose()

				this.activeDownloadKeys.delete(downloadKey)
			})

			if (!(destination instanceof FileSystem.File)) {
				throw new Error("Destination must be a file for file downloads.")
			}

			const remoteAnyFile: AnyFile = (() => {
				switch (item.type) {
					case "file": {
						return new AnyFile.File(item.data)
					}

					case "sharedFile": {
						return new AnyFile.Shared(item.data)
					}
				}
			})()

			if (!hideProgress) {
				useTransfersStore.getState().setTransfers(prev => [
					...prev,
					{
						id: itemUuid,
						item: item.data,
						type: "downloadFile",
						size: Number(item.data.size),
						bytesTransferred: 0,
						startedAt: Date.now(),
						abortController: transferAbortController,
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
			}

			if (!hideProgress) {
				defer(() => {
					;(awaitExternalCompletionBeforeMarkingAsFinished ? awaitExternalCompletionBeforeMarkingAsFinished() : Promise.resolve())
						.then(() => {
							useTransfersStore.getState().setTransfers(prev =>
								prev.map(t =>
									t.id === itemUuid
										? {
												...t,
												finishedAt: Date.now()
											}
										: t
								)
							)
						})
						.catch(console.error)
				})
			}

			const cachedFile = await run(async () => {
				if (await fileCache.has(item)) {
					return await fileCache.get({
						item,
						signal: compositeAbortSignal
					})
				}

				return null
			})

			if (destination.exists) {
				destination.delete()
			}

			if (cachedFile.success && cachedFile.data) {
				cachedFile.data.copy(destination)

				if (!hideProgress) {
					useTransfersStore.getState().setTransfers(prev =>
						prev.map(t =>
							t.id === itemUuid
								? {
										...t,
										bytesTransferred: Number(item.data.size)
									}
								: t
						)
					)
				}
			} else {
				await authedSdkClient.downloadFileToPath(
					remoteAnyFile,
					normalizeFilePathForSdk(destination.uri),
					{
						onUpdate(downloadedBytes) {
							useTransfersStore.getState().setTransfers(prev =>
								prev.map(t =>
									t.id === itemUuid
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
						abortSignal: wrapAbortSignalForSdk(compositeAbortSignal)
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

			return transferred
		})

		if (!result.success) {
			if (!hideProgress) {
				useTransfersStore.getState().setTransfers(prev =>
					prev.map(t =>
						t.id === itemUuid && t.type === "downloadFile"
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
