import { AnyFile, MaybeEncryptedUniffi_Tags } from "@filen/sdk-rs"
import { type LinkResult } from "@/features/chats/queries/useChatMessageLinks.query"
import { linkedFileIntoDriveItem } from "@/lib/sdkUnwrap"
import useDrivePreviewStore from "@/stores/useDrivePreview.store"
import alerts from "@/lib/alerts"
import { t as i18nT } from "@/lib/i18n"

// The decrypted-file/directory shape carried by a successful internal link.
export type InternalLinkData = Extract<
	LinkResult,
	{
		type: "internal"
		success: true
	}
>["data"]

export type SuccessfulLink = Extract<
	LinkResult,
	{
		success: true
	}
>

export type ResolvedLinkMedia = {
	type: "image" | "video" | "internal" | null
	url: string | null
	name: string | null
	linked: InternalLinkData | null
}

// Pure classifier shared by the single- and multi-attachment render paths. Collapses the
// 4× (single|multi × image|video) duplication plus the internal/none fall-through into one
// decision. Mirrors the original branch order exactly: image → video → internal → none.
// `getFileUrl` is the only effectful dependency (it builds an AnyFile.Linked HTTP url); when
// absent, internal media cannot be served so those links fall through to the internal/none path.
export function resolveLinkMedia(
	link: SuccessfulLink,
	getFileUrl: ((file: AnyFile) => string) | null | undefined
): ResolvedLinkMedia {
	const internalData = link.type === "internal" ? link.data : null

	const linkedFileName = (data: InternalLinkData): string | null => {
		if (data.type !== "file") {
			return null
		}

		return data.file.name.tag === MaybeEncryptedUniffi_Tags.Decrypted ? data.file.name.inner[0] : data.file.uuid
	}

	const linkedFileUrl = (data: InternalLinkData): string | null => {
		if (!getFileUrl || data.type !== "file") {
			return null
		}

		return getFileUrl(new AnyFile.Linked(data.file))
	}

	if (
		(link.type === "external" && link.data.previewType === "image") ||
		(link.type === "internal" && link.data.type === "file" && link.data.previewType === "image" && Boolean(getFileUrl))
	) {
		const url = link.type === "external" ? link.data.url : link.data.type === "file" ? linkedFileUrl(link.data) : null
		const name = link.type === "external" ? link.data.name : link.data.type === "file" ? linkedFileName(link.data) : null

		if (url && name) {
			return {
				type: "image",
				url,
				name,
				linked: internalData
			}
		}
	}

	if (
		(link.type === "external" && link.data.previewType === "video") ||
		(link.type === "internal" && link.data.type === "file" && link.data.previewType === "video" && Boolean(getFileUrl))
	) {
		const url = link.type === "external" ? link.data.url : link.data.type === "file" ? linkedFileUrl(link.data) : null
		const name = link.type === "external" ? link.data.name : link.data.type === "file" ? linkedFileName(link.data) : null

		if (url && name) {
			return {
				type: "video",
				url,
				name,
				linked: internalData
			}
		}
	}

	if (link.type === "internal") {
		return {
			type: "internal",
			url: null,
			name: null,
			linked: link.data
		}
	}

	return {
		type: null,
		url: null,
		name: null,
		linked: null
	}
}

// Opens the right preview surface for an image/video attachment: a linked drive file routes
// through the in-app drive gallery (with a decrypt guard), everything else opens the external
// url preview. Effectful — drives the drive-preview store and surfaces a decrypt toast.
export function openAttachmentPreview({
	linked,
	url,
	name
}: {
	linked: InternalLinkData | null | undefined
	url: string
	name: string
}): void {
	if (linked && linked.type === "file") {
		const driveItem = linkedFileIntoDriveItem(linked.file)

		if (driveItem.type !== "file") {
			return
		}

		if (driveItem.data.decryptedMeta === null) {
			alerts.normal(i18nT("cannot_decrypt_toast"))

			return
		}

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

		return
	}

	useDrivePreviewStore.getState().open({
		initialItem: {
			type: "external",
			data: {
				url,
				name
			}
		},
		items: [
			{
				type: "external",
				data: {
					url,
					name
				}
			}
		]
	})
}
