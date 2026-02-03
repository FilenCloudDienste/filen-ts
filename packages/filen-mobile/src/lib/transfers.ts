import auth from "@/lib/auth"
import { run } from "@filen/utils"
import * as FileSystem from "expo-file-system"
import {
	type Dir,
	File,
	AnyDirEnumWithShareInfo,
	type FileWithPath,
	type DirWithPath,
	FilenSdkError,
	NonRootItemTagged,
	ManagedFuture,
	ParentUuid,
	type DirEnum,
	DirEnum_Tags
} from "@filen/sdk-rs"
import useTransfersStore from "@/stores/useTransfers.store"
import {
	normalizeFilePathForSdk,
	unwrapDirMeta,
	unwrapFileMeta,
	wrapAbortSignalForSdk,
	PauseSignal,
	createCompositeAbortSignal,
	createCompositePauseSignal
} from "@/lib/utils"
import { driveItemsQueryUpdate } from "@/queries/useDriveItems.query"
import type { DriveItem } from "@/types"

class Transfers {
	private globalAbortController = new AbortController()
	private globalPauseSignal = new PauseSignal()

	public cancelAll(): void {
		this.globalAbortController.abort()
		this.globalAbortController = new AbortController()
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
		parent
	}: {
		id: string
		localFileOrDir: FileSystem.File | FileSystem.Directory
		parent: DirEnum
	}): Promise<{
		files: File[]
		directories: Dir[]
	}> {
		const currentTransfers = useTransfersStore.getState().transfers.filter(t => !t.finishedAt)

		if (
			currentTransfers.find(t => t.id === id) ||
			currentTransfers.find(
				t => (t.type === "uploadDirectory" || t.type === "uploadFile") && t.localFileOrDir.uri === localFileOrDir.uri
			)
		) {
			throw new Error("A transfer with the same ID or local URI is already in progress.")
		}

		const sdkClient = await auth.getSdkClient()
		const transferAbortController = new AbortController()
		const transferPauseSignal = new PauseSignal()
		const compositePauseSignal = createCompositePauseSignal(this.globalPauseSignal, transferPauseSignal)
		const compositeAbortSignal = createCompositeAbortSignal(this.globalAbortController.signal, transferAbortController.signal)

		if (localFileOrDir instanceof FileSystem.File) {
			if (!localFileOrDir.exists || !localFileOrDir.size) {
				throw new Error("Local file does not exist or is empty.")
			}

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
		} else {
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

		if (localFileOrDir instanceof FileSystem.Directory) {
			const result = await run(async defer => {
				if (parent.tag === DirEnum_Tags.Root) {
					throw new Error("Cannot upload to root directory.")
				}

				defer(() => {
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

				const transferred: {
					files: File[]
					directories: Dir[]
				} = {
					files: [],
					directories: []
				}

				await sdkClient.uploadDirRecursively(
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

								const { meta, dir, shared } = unwrapDirMeta(uploadedDir)

								if (!shared) {
									driveItemsQueryUpdate({
										params: {
											path: {
												type: "drive",
												uuid: parent.inner[0].uuid
											}
										},
										updater: prev => [
											...prev.filter(item => item.data.uuid !== uploadedDir.uuid),
											{
												type: "directory",
												data: {
													...dir,
													size: 0n,
													decryptedMeta: meta
												}
											}
										]
									})
								}
							}

							for (const uploadedFile of uploadedFiles) {
								transferred.files.push(uploadedFile)

								const { meta, shared, file } = unwrapFileMeta(uploadedFile)

								if (!shared) {
									driveItemsQueryUpdate({
										params: {
											path: {
												type: "drive",
												uuid: parent.inner[0].uuid
											}
										},
										updater: prev => [
											...prev.filter(item => item.data.uuid !== uploadedFile.uuid),
											{
												type: "file",
												data: {
													...file,
													decryptedMeta: meta
												}
											}
										]
									})
								}
							}
						}
					},
					new NonRootItemTagged.Dir(parent.inner[0]).inner[0],
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

				throw result.error
			}

			return result.data
		}

		// TODO: Add metadata timestamps before upload to copied file
		const result = await run(async defer => {
			defer(() => {
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

			const transferred = await sdkClient.uploadFile(
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

			throw result.error
		}

		const { meta, shared, file } = unwrapFileMeta(result.data)

		if (!shared) {
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
							...file,
							decryptedMeta: meta
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
		destination
	}: {
		itemUuid: string
		item: DriveItem
		destination: FileSystem.File | FileSystem.Directory
	}): Promise<{
		files: FileWithPath[]
		directories: DirWithPath[]
	}> {
		const currentTransfers = useTransfersStore
			.getState()
			.transfers.filter(t => !t.finishedAt && (t.type === "downloadFile" || t.type === "downloadDirectory"))

		if (
			currentTransfers.find(
				t =>
					(t.type === "downloadFile" || t.type === "downloadDirectory") &&
					t.id === itemUuid &&
					t.destination.uri === destination.uri
			)
		) {
			throw new Error("A transfer with the same ID and destination URI is already in progress.")
		}

		const sdkClient = await auth.getSdkClient()
		const transferAbortController = new AbortController()
		const transferPauseSignal = new PauseSignal()
		const compositePauseSignal = createCompositePauseSignal(this.globalPauseSignal, transferPauseSignal)
		const compositeAbortSignal = createCompositeAbortSignal(this.globalAbortController.signal, transferAbortController.signal)

		if (item.type === "file" || item.type === "sharedFile") {
			if (!(destination instanceof FileSystem.File)) {
				throw new Error("Destination must be a file for file downloads.")
			}

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
		} else {
			if (destination instanceof FileSystem.File) {
				throw new Error("Destination must be a directory for directory downloads.")
			}

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

		if (item.type === "directory" || item.type === "sharedDirectory") {
			const result = await run(async defer => {
				defer(() => {
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

				const transferred: {
					files: FileWithPath[]
					directories: DirWithPath[]
				} = {
					files: [],
					directories: []
				}

				await sdkClient.downloadDirRecursively(
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
					item.type === "directory"
						? new AnyDirEnumWithShareInfo.Dir(item.data)
						: new AnyDirEnumWithShareInfo.SharedDir(item.data),
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

				throw result.error
			}

			return result.data
		}

		const file =
			item.type === "file"
				? // Regular file
					new NonRootItemTagged.File(item.data).inner[0]
				: // Shared file
					new NonRootItemTagged.File({
						...item.data.file,
						// We don't really care about the parent for downloads, just need to provide some value
						parent: new ParentUuid.Uuid(item.data.uuid),
						favorited: false
					}).inner[0]

		const result = await run(async defer => {
			defer(() => {
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

			await sdkClient.downloadFile(
				file,
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

			const transferred = {
				files: [
					{
						path: normalizeFilePathForSdk(destination.uri),
						file
					}
				],
				directories: []
			}

			return transferred
		})

		if (!result.success) {
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
														error: FilenSdkError.getInner(result.error),
														item: new NonRootItemTagged.File(file)
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

			throw result.error
		}

		return result.data
	}
}

const transfers = new Transfers()

export default transfers
