import { type LinkedFile } from "@filen/sdk-rs"
import { linkedFileIntoDriveItem } from "@/lib/sdkUnwrap"
import useDrivePreviewStore from "@/stores/useDrivePreview.store"
import cache from "@/lib/cache"
import alerts from "@/lib/alerts"
import { t as i18nT } from "@/lib/i18n"

// Opens a public file link (a chat attachment) in the gallery as a link view. The raw LinkedFile is kept
// first: Save to Cloud Drive is offered only while it is held and copies from it, and nothing else on this
// path caches it.
export function openLinkedFilePreview(file: LinkedFile): void {
	const driveItem = linkedFileIntoDriveItem(file)

	if (driveItem.type !== "file") {
		return
	}

	if (driveItem.data.decryptedMeta === null) {
		alerts.normal(i18nT("cannot_decrypt_toast"))

		return
	}

	cache.linkedFileByUuid.set(file.uuid, file)

	useDrivePreviewStore.getState().open({
		initialItem: {
			type: "drive",
			data: {
				item: driveItem,
				drivePath: {
					type: "linked",
					uuid: null
				}
			}
		},
		items: [
			{
				type: "drive",
				data: driveItem
			}
		]
	})
}
