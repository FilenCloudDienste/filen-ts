import { type TFunction } from "i18next"
import { run, type Result } from "@filen/shared"
import { AnyNormalDir } from "@filen/sdk-rs"
import * as FileSystem from "expo-file-system"
import { ensureDirectory } from "@/lib/fsUtils"
import { extnameOf } from "@/lib/previewType"
import DocumentScanner, {
	ResponseType as DocumentScannerResponseType,
	ScanDocumentResponseStatus
} from "react-native-document-scanner-plugin"
import { normalizeFilePathForExpo } from "@/lib/paths"
import { isConvertHeicToJpgEnabled, convertHeicToJpg } from "@/lib/imageConversion"
import { withSystemPresentation } from "@/lib/systemPresentation"
import { pickDocuments } from "@/lib/documentPicker"
import { pickMedia, pickedAssetName, requireMediaPermissions, type MediaSource } from "@/lib/mediaPicker"
import { notifyIfNameIsHidden } from "@/features/drive/components/hiddenNameNotice"
import { hiddenFilterAppliesTo, isFileItem } from "@/features/drive/driveSelectors"
import transfers from "@/features/transfers/transfers"
import alerts from "@/lib/alerts"
import { inputPrompt } from "@/lib/promptFlow"
import { runWithLoading } from "@/components/ui/fullScreenLoadingModal"
import { uploadQuotaRefusal } from "@/features/transfers/quota"
import { newTmpDir } from "@/lib/tmp"
import { unwrapFileMeta, unwrappedFileIntoDriveItem } from "@/lib/sdkUnwrap"
import { useDrivePreviewStore } from "@/stores/useDrivePreview.store"
import type { DrivePath } from "@/hooks/useDrivePath"
import logger from "@/lib/logger"

// Convert a picked HEIC/HEIF asset to JPG when the global option is on, adjusting the
// upload name + mime to match. Returns the file to upload plus the converted tmp file
// (if any) so the caller can clean it up. convertHeicToJpg no-ops on non-HEIC input and
// returns the original on failure, so a non-image or a failed conversion uploads as-is.
async function maybeConvertHeicForUpload({
	file,
	name,
	mime,
	enabled
}: {
	file: FileSystem.File
	name: string
	mime: string | undefined
	enabled: boolean
}): Promise<{
	file: FileSystem.File
	name: string
	mime: string | undefined
	convertedTmpFile: FileSystem.File | null
}> {
	if (!enabled) {
		return {
			file,
			name,
			mime,
			convertedTmpFile: null
		}
	}

	const converted = await convertHeicToJpg(file)

	if (converted.uri === file.uri) {
		return {
			file,
			name,
			mime,
			convertedTmpFile: null
		}
	}

	return {
		file: converted,
		name: `${FileSystem.Paths.basename(name, extnameOf(name))}.jpg`,
		mime: "image/jpeg",
		convertedTmpFile: converted
	}
}

export type UseDriveUpload = {
	uploadFiles: () => Promise<void>
	uploadPhotosOrVideos: () => Promise<void>
	takePhotoOrVideo: () => Promise<void>
	scanDocument: () => Promise<void>
	createTextFile: () => Promise<void>
}

// Pure, unit-testable tally of a settled upload fan-out. `transfers.upload` resolves `null`
// when the transfer was aborted/cancelled — that is neither a success nor a failure, so
// aborted entries are excluded from BOTH counts (an all-aborted batch must not produce an
// "Upload complete" toast, and aborts must not inflate the "{{failed}} failed" suffix).
export function summarizeTransferResults(results: PromiseSettledResult<Result<unknown>>[]): {
	succeeded: number
	failed: number
	aborted: number
	errors: unknown[]
} {
	let succeeded = 0
	let aborted = 0
	const errors: unknown[] = []

	for (const r of results) {
		if (r.status === "rejected") {
			errors.push(r.reason)
		} else if (!r.value.success) {
			errors.push(r.value.error)
		} else if (r.value.data === null) {
			aborted++
		} else {
			succeeded++
		}
	}

	return {
		succeeded,
		failed: errors.length,
		aborted,
		errors
	}
}

/**
 * The four near-identical "add content" upload flows surfaced in the Drive
 * header's Upload menu: document picker, photo-library picker, camera capture,
 * and document scanner. Each resolves a set of local assets, fans them out with
 * `Promise.allSettled`, uploads each via `transfers.upload`, then surfaces any
 * per-item failures. Behavior is identical to the previous inline handlers.
 *
 * `parent` may be null (hooks can't be called conditionally); each handler
 * no-ops when there is no upload target — the menu only renders these entries
 * when a parent exists anyway.
 */
export function useDriveUpload({
	parent,
	drivePath,
	t
}: {
	parent: AnyNormalDir | null
	drivePath: DrivePath
	t: TFunction
}): UseDriveUpload {
	// Shared tail: surface rejected fan-out entries + failed uploads, then a success
	// toast summarizing the batch. Per-failure errors are still shown above; the toast
	// only appears when at least one upload ACTUALLY succeeded (an all-failed batch is
	// already fully covered by the error banners, and an all-aborted batch was cancelled
	// by the user — a "success" toast in either case would be a lie).
	const reportTransferResults = (results: PromiseSettledResult<Result<unknown>>[]): void => {
		const { succeeded, failed, errors } = summarizeTransferResults(results)

		for (const error of errors) {
			logger.error("drive-upload", "upload item failed", { error: error })
			alerts.error(error)
		}

		if (succeeded === 0) {
			return
		}

		alerts.normal(
			failed > 0
				? t("upload_complete_with_failures", {
						count: succeeded,
						failed
					})
				: t("upload_complete", {
						count: succeeded
					})
		)
	}

	// Refuses a batch that won't fit before any transfer row exists, shown like any failed upload; the
	// picked files are then this flow's to delete.
	const fitsOrRefuse = async (files: FileSystem.File[]): Promise<boolean> => {
		const refusal = await uploadQuotaRefusal(files.map(file => (file.exists ? file.size : 0)))

		if (!refusal) {
			return true
		}

		for (const file of files) {
			if (file.exists) {
				file.delete()
			}
		}

		alerts.error(refusal)

		return false
	}

	const uploadFiles = async (): Promise<void> => {
		if (!parent) {
			return
		}

		const documentPickerResult = await run(async () => {
			return await pickDocuments({
				type: "*/*",
				multiple: true
			})
		})

		if (!documentPickerResult.success) {
			logger.warn("drive-upload", "document picker failed", { error: documentPickerResult.error })
			alerts.error(documentPickerResult.error)

			return
		}

		if (documentPickerResult.data.canceled) {
			return
		}

		const assets = documentPickerResult.data.documents

		if (!(await fitsOrRefuse(assets.map(asset => new FileSystem.File(asset.uri))))) {
			return
		}

		const convertHeic = await isConvertHeicToJpgEnabled()

		const transferResult = await run(async () => {
			return await Promise.allSettled(
				assets.map(async asset => {
					return await run(
						async defer => {
							const assetFile = new FileSystem.File(asset.uri)

							defer(() => {
								if (assetFile.exists) {
									assetFile.delete()
								}
							})

							if (!assetFile.exists) {
								throw new Error("Asset file does not exist")
							}

							const converted = await maybeConvertHeicForUpload({
								file: assetFile,
								name: asset.name,
								mime: asset.mimeType,
								enabled: convertHeic
							})

							if (converted.convertedTmpFile) {
								const convertedTmpFile = converted.convertedTmpFile

								defer(() => {
									if (convertedTmpFile.exists) {
										convertedTmpFile.delete()
									}
								})
							}

							return await transfers.upload({
								localFileOrDir: converted.file,
								parent,
								name: converted.name,
								modified: asset.lastModified,
								mime: converted.mime
							})
						},
						{
							throw: true
						}
					)
				})
			)
		})

		if (!transferResult.success) {
			logger.error("drive-upload", "uploadFiles fan-out failed", { error: transferResult.error, count: assets.length })
			alerts.error(transferResult.error)

			return
		}

		reportTransferResults(transferResult.data)
	}

	// Shared body for library-picker and camera-capture flows. Camera captures record the current
	// time; library assets already carry their own metadata via the OS.
	const uploadFromPicker = async (source: MediaSource): Promise<void> => {
		if (!parent) {
			return
		}

		const assets = await pickMedia({ source })

		if (!assets) {
			return
		}

		if (!(await fitsOrRefuse(assets.map(asset => new FileSystem.File(asset.uri))))) {
			return
		}

		const convertHeic = await isConvertHeicToJpgEnabled()

		const transferResult = await run(async () => {
			return await Promise.allSettled(
				assets.map(async asset => {
					return await run(
						async defer => {
							const assetFile = new FileSystem.File(asset.uri)

							defer(() => {
								if (assetFile.exists) {
									assetFile.delete()
								}
							})

							if (!assetFile.exists) {
								throw new Error("Asset file does not exist")
							}

							const converted = await maybeConvertHeicForUpload({
								file: assetFile,
								name: pickedAssetName(asset),
								mime: asset.mimeType,
								enabled: convertHeic
							})

							if (converted.convertedTmpFile) {
								const convertedTmpFile = converted.convertedTmpFile

								defer(() => {
									if (convertedTmpFile.exists) {
										convertedTmpFile.delete()
									}
								})
							}

							return await transfers.upload({
								localFileOrDir: converted.file,
								parent,
								name: converted.name,
								mime: converted.mime,
								...(source === "camera" ? { created: Date.now(), modified: Date.now() } : {})
							})
						},
						{
							throw: true
						}
					)
				})
			)
		})

		if (!transferResult.success) {
			logger.error("drive-upload", "uploadFromPicker fan-out failed", { error: transferResult.error, count: assets.length })
			alerts.error(transferResult.error)

			return
		}

		reportTransferResults(transferResult.data)
	}

	const uploadPhotosOrVideos = (): Promise<void> => {
		return uploadFromPicker("library")
	}

	const takePhotoOrVideo = (): Promise<void> => {
		return uploadFromPicker("camera")
	}

	const scanDocument = async (): Promise<void> => {
		if (!parent) {
			return
		}

		if (!(await requireMediaPermissions({ needCamera: true }))) {
			return
		}

		const scannerResult = await run(async () => {
			return await withSystemPresentation(() =>
				DocumentScanner.scanDocument({
					maxNumDocuments: undefined,
					croppedImageQuality: 100,
					responseType: DocumentScannerResponseType.ImageFilePath
				})
			)
		})

		if (!scannerResult.success) {
			logger.warn("drive-upload", "document scanner failed", { error: scannerResult.error })
			alerts.error(scannerResult.error)

			return
		}

		if (scannerResult.data.status !== ScanDocumentResponseStatus.Success) {
			return
		}

		const scans = scannerResult.data.scannedImages

		if (!scans || scans.length === 0) {
			return
		}

		if (!(await fitsOrRefuse(scans.map(scan => new FileSystem.File(normalizeFilePathForExpo(scan)))))) {
			return
		}

		const transferResult = await run(async () => {
			return await Promise.allSettled(
				scans.map(async scan => {
					return await run(
						async defer => {
							const scanFile = new FileSystem.File(normalizeFilePathForExpo(scan))

							defer(() => {
								if (scanFile.exists) {
									scanFile.delete()
								}
							})

							return await transfers.upload({
								localFileOrDir: scanFile,
								parent,
								modified: Date.now(),
								created: Date.now(),
								name: `${t("scanned_document_name")}_${new Date().toISOString().replace(/[:.]/g, "-")}.jpg`,
								mime: "image/jpeg"
							})
						},
						{
							throw: true
						}
					)
				})
			)
		})

		if (!transferResult.success) {
			logger.error("drive-upload", "scanDocument fan-out failed", { error: transferResult.error, count: scans.length })
			alerts.error(transferResult.error)

			return
		}

		reportTransferResults(transferResult.data)
	}

	const createTextFile = async (): Promise<void> => {
		if (!parent) {
			return
		}

		let fileName = await inputPrompt(
			{
				title: t("create_text_file"),
				message: t("enter_text_file_name"),
				cancelText: t("cancel"),
				okText: t("create"),
				placeholder: t("text_file_name")
			},
			{ tag: "drive-upload", message: "create text file prompt failed" },
			{ trim: true }
		)

		if (fileName === null) {
			return
		}

		const extname = extnameOf(fileName)

		if (extname.length === 0) {
			fileName += ".txt"
		}

		const result = await runWithLoading(async defer => {
			const tmpDir = newTmpDir()
			const tmpFile = new FileSystem.File(FileSystem.Paths.join(tmpDir.uri, fileName))

			defer(() => {
				if (tmpDir.exists) {
					tmpDir.delete()
				}
			})

			ensureDirectory(tmpDir)

			if (tmpFile.exists) {
				tmpFile.delete()
			}

			tmpFile.write("", {
				encoding: "utf8"
			})

			return await transfers.upload({
				localFileOrDir: tmpFile,
				parent,
				name: fileName,
				mime: "text/plain",
				modified: Date.now(),
				created: Date.now()
			})
		})

		if (!result.success) {
			logger.error("drive-upload", "createTextFile failed", { error: result.error, fileName })
			alerts.error(result.error)

			return
		}

		// Same silence as the create-directory prompt: the user typed this name, and with the
		// preference on the file will not appear in the listing they return to.
		await notifyIfNameIsHidden({ name: fileName, action: "created", appliesHere: hiddenFilterAppliesTo(drivePath), t })

		if (!result.data) {
			return
		}

		const file = result.data.files.at(0)

		if (!file) {
			return
		}

		const item = unwrappedFileIntoDriveItem(unwrapFileMeta(file))

		if (!isFileItem(item)) {
			return
		}

		useDrivePreviewStore.getState().open({
			initialItem: {
				type: "drive",
				data: {
					item: item,
					drivePath
				}
			},
			items: [
				{
					type: "drive",
					data: item
				}
			]
		})
	}

	return {
		uploadFiles,
		uploadPhotosOrVideos,
		takePhotoOrVideo,
		scanDocument,
		createTextFile
	}
}

export default useDriveUpload
