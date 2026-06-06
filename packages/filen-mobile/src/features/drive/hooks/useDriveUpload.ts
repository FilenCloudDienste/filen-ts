import { type TFunction } from "i18next"
import { run, type Result } from "@filen/utils"
import { AnyNormalDir } from "@filen/sdk-rs"
import * as FileSystem from "expo-file-system"
import * as DocumentPicker from "expo-document-picker"
import * as ImagePicker from "expo-image-picker"
import DocumentScanner, {
	ResponseType as DocumentScannerResponseType,
	ScanDocumentResponseStatus
} from "react-native-document-scanner-plugin"
import { randomUUID } from "expo-crypto"
import { normalizeFilePathForExpo } from "@/lib/paths"
import { hasAllNeededMediaPermissions } from "@/hooks/useMediaPermissions"
import transfers from "@/features/transfers/transfers"
import alerts from "@/lib/alerts"
import prompts from "@/lib/prompts"
import { runWithLoading } from "@/components/ui/fullScreenLoadingModal"
import { newTmpDir } from "@/lib/tmp"
import { unwrapFileMeta, unwrappedFileIntoDriveItem } from "@/lib/sdkUnwrap"
import { useDrivePreviewStore } from "@/stores/useDrivePreview.store"
import type { DrivePath } from "@/hooks/useDrivePath"

export type UseDriveUpload = {
	uploadFiles: () => Promise<void>
	uploadPhotosOrVideos: () => Promise<void>
	takePhotoOrVideo: () => Promise<void>
	scanDocument: () => Promise<void>
	createTextFile: () => Promise<void>
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
	// Shared tail: surface rejected fan-out entries and failed uploads.
	const reportTransferResults = (results: PromiseSettledResult<Result<unknown>>[]): void => {
		for (const r of results) {
			if (r.status === "rejected") {
				console.error(r.reason)
				alerts.error(r.reason)
			} else if (!r.value.success) {
				console.error(r.value.error)
				alerts.error(r.value.error)
			}
		}

		// TODO: display toast on upload success with number of successfully uploaded files and number of failed uploads
	}

	const requireMediaPermissions = async (): Promise<boolean> => {
		const permissionsResult = await run(async () => {
			return await hasAllNeededMediaPermissions({
				shouldRequest: true
			})
		})

		if (!permissionsResult.success) {
			console.error(permissionsResult.error)
			alerts.error(permissionsResult.error)

			return false
		}

		if (!permissionsResult.data) {
			alerts.error(t("no_permissions_enable_manually"))

			return false
		}

		return true
	}

	const uploadFiles = async (): Promise<void> => {
		if (!parent) {
			return
		}

		const documentPickerResult = await run(async () => {
			return await DocumentPicker.getDocumentAsync({
				type: "*/*",
				multiple: true,
				copyToCacheDirectory: true,
				base64: false
			})
		})

		if (!documentPickerResult.success) {
			console.error(documentPickerResult.error)
			alerts.error(documentPickerResult.error)

			return
		}

		if (documentPickerResult.data.canceled) {
			return
		}

		const assets = documentPickerResult.data.assets

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

							return await transfers.upload({
								localFileOrDir: assetFile,
								parent,
								name: asset.name,
								modified: asset.lastModified,
								mime: asset.mimeType
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
			console.error(transferResult.error)
			alerts.error(transferResult.error)

			return
		}

		reportTransferResults(transferResult.data)
	}

	// Shared body for library-picker and camera-capture flows. The only
	// differences between uploadPhotosOrVideos and takePhotoOrVideo are the
	// ImagePicker launcher used and whether created/modified timestamps are
	// injected (camera captures should record the current time; library assets
	// already carry their own metadata via the OS).
	const uploadFromPicker = async (launcher: () => Promise<ImagePicker.ImagePickerResult>, addTimestamps: boolean): Promise<void> => {
		if (!parent) {
			return
		}

		if (!(await requireMediaPermissions())) {
			return
		}

		const imagePickerResult = await run(async () => {
			return await launcher()
		})

		if (!imagePickerResult.success) {
			console.error(imagePickerResult.error)
			alerts.error(imagePickerResult.error)

			return
		}

		if (imagePickerResult.data.canceled) {
			return
		}

		const assets = imagePickerResult.data.assets

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

							const extname = FileSystem.Paths.extname(asset.uri)
							const fileName = asset.fileName ?? `${randomUUID()}${extname}`

							return await transfers.upload({
								localFileOrDir: assetFile,
								parent,
								name: fileName,
								mime: asset.mimeType,
								...(addTimestamps ? { created: Date.now(), modified: Date.now() } : {})
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
			console.error(transferResult.error)
			alerts.error(transferResult.error)

			return
		}

		reportTransferResults(transferResult.data)
	}

	const uploadPhotosOrVideos = (): Promise<void> => {
		return uploadFromPicker(
			() =>
				ImagePicker.launchImageLibraryAsync({
					mediaTypes: ["images", "videos"],
					exif: false,
					base64: false,
					quality: 1,
					allowsMultipleSelection: true,
					presentationStyle: ImagePicker.UIImagePickerPresentationStyle.PAGE_SHEET,
					shouldDownloadFromNetwork: true
				}),
			false
		)
	}

	const takePhotoOrVideo = (): Promise<void> => {
		return uploadFromPicker(
			() =>
				ImagePicker.launchCameraAsync({
					mediaTypes: ["images", "videos"],
					exif: false,
					base64: false,
					quality: 1,
					allowsMultipleSelection: true,
					presentationStyle: ImagePicker.UIImagePickerPresentationStyle.PAGE_SHEET,
					shouldDownloadFromNetwork: true
				}),
			true
		)
	}

	const scanDocument = async (): Promise<void> => {
		if (!parent) {
			return
		}

		if (!(await requireMediaPermissions())) {
			return
		}

		const scannerResult = await run(async () => {
			return await DocumentScanner.scanDocument({
				maxNumDocuments: undefined,
				croppedImageQuality: 100,
				responseType: DocumentScannerResponseType.ImageFilePath
			})
		})

		if (!scannerResult.success) {
			console.error(scannerResult.error)
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
			console.error(transferResult.error)
			alerts.error(transferResult.error)

			return
		}

		reportTransferResults(transferResult.data)
	}

	const createTextFile = async (): Promise<void> => {
		if (!parent) {
			return
		}

		const promptResult = await run(async () => {
			return await prompts.input({
				title: t("create_text_file"),
				message: t("enter_text_file_name"),
				cancelText: t("cancel"),
				okText: t("create"),
				placeholder: t("text_file_name")
			})
		})

		if (!promptResult.success) {
			console.error(promptResult.error)
			alerts.error(promptResult.error)

			return
		}

		if (promptResult.data.cancelled || promptResult.data.type !== "string") {
			return
		}

		let fileName = promptResult.data.value.trim()

		if (fileName.length === 0) {
			return
		}

		const extname = FileSystem.Paths.extname(fileName)

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

			if (!tmpDir.exists) {
				tmpDir.create({
					idempotent: true,
					intermediates: true
				})
			}

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
			console.error(result.error)
			alerts.error(result.error)

			return
		}

		if (!result.data) {
			return
		}

		const file = result.data.files.at(0)

		if (!file) {
			return
		}

		const item = unwrappedFileIntoDriveItem(unwrapFileMeta(file))

		if (item.type !== "file" && item.type !== "sharedFile" && item.type !== "sharedRootFile") {
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
