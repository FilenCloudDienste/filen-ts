import * as FileSystem from "expo-file-system"
import * as ImageManipulator from "expo-image-manipulator"
import { type ImagePickerAsset } from "expo-image-picker"
import { EXPO_IMAGE_MANIPULATOR_SUPPORTED_EXTENSIONS } from "@/constants"
import i18n from "@/lib/i18n"
import { type DeferFn } from "@filen/utils"

// Validates a freshly-picked image and, when it isn't already JPEG/PNG, transcodes it to JPEG
// via expo-image-manipulator. Returns the on-disk File ready to upload as the account avatar.
// `defer` (from the caller's runWithLoading/run) registers temp-file cleanup so it always runs.
// Throws localized errors: avatar_upload_failed / avatar_not_an_image / avatar_unsupported_format.
export async function prepareAvatarFileForUpload({ asset, defer }: { asset: ImagePickerAsset; defer: DeferFn }): Promise<FileSystem.File> {
	const originalFile = new FileSystem.File(asset.uri)

	defer(() => {
		if (originalFile.exists) {
			originalFile.delete()
		}
	})

	if (!originalFile.exists) {
		throw new Error(i18n.t("avatar_upload_failed"))
	}

	if (!asset.mimeType || !asset.mimeType.toLowerCase().startsWith("image/") || !asset.fileSize || !asset.fileName) {
		throw new Error(i18n.t("avatar_not_an_image"))
	}

	const mimeType = asset.mimeType?.toLowerCase()
	let fileToUpload = originalFile

	if (mimeType !== "image/jpeg" && mimeType !== "image/png") {
		if (!EXPO_IMAGE_MANIPULATOR_SUPPORTED_EXTENSIONS.has(FileSystem.Paths.extname(asset.fileName).toLowerCase())) {
			throw new Error(i18n.t("avatar_unsupported_format"))
		}

		// Hold the Context in a local binding across the await. expo-image-manipulator's
		// Context overrides sharedObjectDidRelease to cancel its underlying coroutine task;
		// if the chained intermediate ref were eligible for Hermes GC during renderAsync,
		// the native task would be cancelled and renderAsync would reject with
		// JobCancellationException.
		const context = ImageManipulator.ImageManipulator.manipulate(asset.uri)
		const manipulated = await context.renderAsync()
		const saved = await manipulated.saveAsync({
			format: ImageManipulator.SaveFormat.JPEG,
			base64: false
		})

		const convertedFile = new FileSystem.File(saved.uri)

		defer(() => {
			if (convertedFile.exists) {
				convertedFile.delete()
			}
		})

		if (!convertedFile.exists) {
			throw new Error(i18n.t("avatar_upload_failed"))
		}

		fileToUpload = convertedFile
	}

	return fileToUpload
}
