import * as ImagePicker from "expo-image-picker"
import * as FileSystem from "expo-file-system"
import { randomUUID } from "expo-crypto"
import { run } from "@filen/shared"
import { hasAllNeededMediaPermissions } from "@/hooks/useMediaPermissions"
import { withSystemPresentation } from "@/lib/systemPresentation"
import alerts from "@/lib/alerts"
import i18n from "@/lib/i18n"
import logger from "@/lib/logger"

export type MediaSource = "library" | "camera"

const PICKER_OPTIONS: ImagePicker.ImagePickerOptions = {
	mediaTypes: ["images", "videos"],
	exif: false,
	base64: false,
	quality: 1,
	allowsMultipleSelection: true,
	presentationStyle: ImagePicker.UIImagePickerPresentationStyle.PAGE_SHEET,
	shouldDownloadFromNetwork: true
}

/**
 * Requests the media permissions (plus camera when asked) behind `withSystemPresentation`, so the
 * system prompt does not trip the privacy cover. Alerts on failure or denial and returns false.
 */
export async function requireMediaPermissions({ needCamera }: { needCamera: boolean }): Promise<boolean> {
	const permissionsResult = await run(async () => {
		return await withSystemPresentation(() =>
			hasAllNeededMediaPermissions({
				shouldRequest: true,
				library: "none",
				needCamera
			})
		)
	})

	if (!permissionsResult.success) {
		logger.error("mediaPicker", "media permissions check failed", { error: permissionsResult.error, needCamera })
		alerts.error(permissionsResult.error)

		return false
	}

	if (!permissionsResult.data) {
		alerts.error(i18n.t("no_permissions_enable_manually"))

		return false
	}

	return true
}

/**
 * Gates on permissions, then opens the photo library or the camera. Alerts on failure; returns null
 * on denial, failure or cancel.
 */
export async function pickMedia({ source }: { source: MediaSource }): Promise<ImagePicker.ImagePickerAsset[] | null> {
	if (!(await requireMediaPermissions({ needCamera: source === "camera" }))) {
		return null
	}

	const imagePickerResult = await run(async () => {
		return await withSystemPresentation(() =>
			source === "camera" ? ImagePicker.launchCameraAsync(PICKER_OPTIONS) : ImagePicker.launchImageLibraryAsync(PICKER_OPTIONS)
		)
	})

	if (!imagePickerResult.success) {
		logger.error("mediaPicker", "image picker failed", { error: imagePickerResult.error, source })
		alerts.error(imagePickerResult.error)

		return null
	}

	if (imagePickerResult.data.canceled) {
		return null
	}

	return imagePickerResult.data.assets
}

export function pickedAssetName(asset: ImagePicker.ImagePickerAsset): string {
	return asset.fileName ?? `${randomUUID()}${FileSystem.Paths.extname(asset.uri)}`
}
