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
	normalizeFilePathForExpo,
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
import drive from "@/lib/drive"
import thumbnails from "@/lib/thumbnails"
import { EXPO_IMAGE_MANIPULATOR_SUPPORTED_EXTENSIONS, EXPO_VIDEO_SUPPORTED_EXTENSIONS } from "@/constants"
import { randomUUID } from "expo-crypto"

class Transfers {
	private globalAbortController = new AbortController()
	private globalPauseSignal = new PauseSignal()

	public cancelAll(): void {
		this.globalAbortController.abort()
		this.globalAbortController = new AbortController()
		this.globalPauseSignal = new PauseSignal()
	}

	public pauseAll(): void {
		this.globalPauseSignal.pause()
	}

	public resumeAll(): void {
		this.globalPauseSignal.resume()
	}

	public async upload({
		localFileOrDir,
		parent,
		hideProgress,
		awaitExternalCompletionBeforeMarkingAsFinished,
		abortController,
		pauseSignal,
		name,
		created,
		modified,
		mime
	}: {
		localFileOrDir: FileSystem.File | FileSystem.Directory
		parent: AnyNormalDir
		hideProgress?: boolean
		awaitExternalCompletionBeforeMarkingAsFinished?: () => Promise<void>
		abortController?: AbortController
		pauseSignal?: PauseSignal
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
		const transferAbortController = abortController ?? new AbortController()
		const transferPauseSignal = pauseSignal ?? new PauseSignal()
		const compositePauseSignal = hideProgress
			? createCompositePauseSignal(transferPauseSignal)
			: createCompositePauseSignal(this.globalPauseSignal, transferPauseSignal)
		const compositeAbortSignal = hideProgress
			? createCompositeAbortSignal(transferAbortController.signal)
			: createCompositeAbortSignal(this.globalAbortController.signal, transferAbortController.signal)

		if (localFileOrDir instanceof FileSystem.Directory) {
			const result = await run(async defer => {
				defer(() => {
					compositePauseSignal.dispose()
					compositeAbortSignal.dispose()
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

					this.globalPauseSignal.addEventListener("pause", transferPauseSignalOnPause)
					this.globalPauseSignal.addEventListener("resume", transferPauseSignalOnResume)

					defer(() => {
						transferPauseSignal.removeEventListener("pause", transferPauseSignalOnPause)
						transferPauseSignal.removeEventListener("resume", transferPauseSignalOnResume)

						this.globalPauseSignal.removeEventListener("pause", transferPauseSignalOnPause)
						this.globalPauseSignal.removeEventListener("resume", transferPauseSignalOnResume)
					})
				}

				if (!hideProgress) {
					defer(() => {
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
									driveItemsQueryUpdate({
										params: {
											path: {
												type: "drive",
												uuid: dirParentUuid
											}
										},
										updater: prev => [
											...prev.filter(
												item =>
													item.data.uuid !== unwrappedDirMeta.uuid &&
													item.data.decryptedMeta?.name.toLowerCase().trim() !==
														unwrappedDirMeta.meta?.name.toLowerCase().trim()
											),
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
											...prev.filter(
												item =>
													item.data.uuid !== unwrappedFileMeta.file.uuid &&
													item.data.decryptedMeta?.name.toLowerCase().trim() !==
														unwrappedFileMeta.meta?.name.toLowerCase().trim()
											),
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

								// TODO: Add thumbnail generation for uploaded files here once sdk exposes different type with path
							}
						}
					},
					parentDir,
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
				if (transferAbortController.signal.aborted || this.globalAbortController.signal.aborted) {
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
			defer(() => {
				compositePauseSignal.dispose()
				compositeAbortSignal.dispose()
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

				this.globalPauseSignal.addEventListener("pause", transferPauseSignalOnPause)
				this.globalPauseSignal.addEventListener("resume", transferPauseSignalOnResume)

				defer(() => {
					transferPauseSignal.removeEventListener("pause", transferPauseSignalOnPause)
					transferPauseSignal.removeEventListener("resume", transferPauseSignalOnResume)

					this.globalPauseSignal.removeEventListener("pause", transferPauseSignalOnPause)
					this.globalPauseSignal.removeEventListener("resume", transferPauseSignalOnResume)
				})
			}

			if (!hideProgress) {
				defer(() => {
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
					mime: mime ?? undefined
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
					abortSignal: wrapAbortSignalForSdk(compositeAbortSignal)
				}),
				{
					signal: compositeAbortSignal
				}
			)

			return transferred
		})

		if (!result.success) {
			if (transferAbortController.signal.aborted || this.globalAbortController.signal.aborted) {
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
			driveItemsQueryUpdate({
				params: {
					path: {
						type: "drive",
						uuid: parent.inner[0].uuid
					}
				},
				updater: prev => [
					...prev.filter(
						item =>
							item.data.uuid !== result.data.uuid &&
							item.data.decryptedMeta?.name.toLowerCase().trim() !== unwrappedFileMeta.meta?.name.toLowerCase().trim()
					),
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

	public async download({
		item,
		destination,
		hideProgress,
		awaitExternalCompletionBeforeMarkingAsFinished,
		abortController,
		pauseSignal
	}: {
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
	} | null> {
		const id = randomUUID()
		const { authedSdkClient } = await auth.getSdkClients()
		const transferAbortController = abortController ?? new AbortController()
		const transferPauseSignal = pauseSignal ?? new PauseSignal()
		const compositePauseSignal = hideProgress
			? createCompositePauseSignal(transferPauseSignal)
			: createCompositePauseSignal(this.globalPauseSignal, transferPauseSignal)
		const compositeAbortSignal = hideProgress
			? createCompositeAbortSignal(transferAbortController.signal)
			: createCompositeAbortSignal(this.globalAbortController.signal, transferAbortController.signal)

		if (item.type === "sharedDirectory" || item.type === "sharedRootDirectory") {
			console.log(item.data)
		}

		if (item.type === "directory" || item.type === "sharedDirectory" || item.type === "sharedRootDirectory") {
			const result = await run(async defer => {
				defer(() => {
					compositePauseSignal.dispose()
					compositeAbortSignal.dispose()
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

					this.globalPauseSignal.addEventListener("pause", transferPauseSignalOnPause)
					this.globalPauseSignal.addEventListener("resume", transferPauseSignalOnResume)

					defer(() => {
						transferPauseSignal.removeEventListener("pause", transferPauseSignalOnPause)
						transferPauseSignal.removeEventListener("resume", transferPauseSignalOnResume)

						this.globalPauseSignal.removeEventListener("pause", transferPauseSignalOnPause)
						this.globalPauseSignal.removeEventListener("resume", transferPauseSignalOnResume)
					})
				}

				if (!hideProgress) {
					defer(() => {
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
						abortSignal: wrapAbortSignalForSdk(compositeAbortSignal)
					}),
					{
						signal: compositeAbortSignal
					}
				)

				return transferred
			})

			if (!result.success) {
				if (destination.exists) {
					destination.delete()
				}

				if (transferAbortController.signal.aborted || this.globalAbortController.signal.aborted) {
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
			defer(() => {
				compositePauseSignal.dispose()
				compositeAbortSignal.dispose()
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

				this.globalPauseSignal.addEventListener("pause", transferPauseSignalOnPause)
				this.globalPauseSignal.addEventListener("resume", transferPauseSignalOnResume)

				defer(() => {
					transferPauseSignal.removeEventListener("pause", transferPauseSignalOnPause)
					transferPauseSignal.removeEventListener("resume", transferPauseSignalOnResume)

					this.globalPauseSignal.removeEventListener("pause", transferPauseSignalOnPause)
					this.globalPauseSignal.removeEventListener("resume", transferPauseSignalOnResume)
				})
			}

			if (!hideProgress) {
				defer(() => {
					;(awaitExternalCompletionBeforeMarkingAsFinished ? awaitExternalCompletionBeforeMarkingAsFinished() : Promise.resolve())
						.then(() => {
							useTransfersStore.getState().setTransfers(prev => prev.filter(t => !(t.id === id && t.type === "downloadFile")))
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
			if (destination.exists) {
				destination.delete()
			}

			if (transferAbortController.signal.aborted || this.globalAbortController.signal.aborted) {
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
