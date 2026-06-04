import { DirColor, MaybeEncryptedUniffi_Tags, DirMeta_Tags } from "@filen/sdk-rs"
import View from "@/components/ui/view"
import Text from "@/components/ui/text"
import { cn, formatBytes, run } from "@filen/utils"
import { linkedFileIntoDriveItem } from "@/lib/utils"
import { Fragment } from "react"
import { simpleDate } from "@/lib/time"
import cache from "@/lib/cache"
import { FileIcon, DirectoryIcon } from "@/components/itemIcons"
import { PressableScale } from "@/components/ui/pressables"
import alerts from "@/lib/alerts"
import drive from "@/features/drive/drive"
import useDrivePreviewStore from "@/stores/useDrivePreview.store"
import { cannotDecryptPlaceholder } from "@/lib/decryption"
import { t as i18nT } from "@/lib/i18n"
import { type InternalLinkData } from "@/features/chats/utils"

export const InternalAttachment = ({
	data,
	layout,
	fromSelf
}: {
	data: InternalLinkData
	layout: {
		width: number
		height: number
	}
	fromSelf: boolean
}) => {
	const maxWH = layout.width * 0.75 - 32 - 24

	return (
		<PressableScale
			className={cn(
				"items-center justify-center rounded-2xl overflow-hidden flex-row px-10 py-4 gap-4",
				fromSelf ? "bg-blue-600" : "bg-background-tertiary"
			)}
			style={{
				width: maxWH
			}}
			onPress={async () => {
				if (data.type === "directory") {
					if (data.info.root.inner.meta.tag !== DirMeta_Tags.Decoded) {
						alerts.normal(i18nT("cannot_decrypt_toast"))

						return
					}

					const result = await run(async () => {
						return await drive.openLinkedDirectory({
							linkUuid: data.info.link.linkUuid,
							linkKey: data.info.link.linkKey,
							root: data.info.root
						})
					})

					if (!result.success) {
						console.error(result.error)
						alerts.error(result.error)

						return
					}

					return
				}

				if (data.file.name.tag !== MaybeEncryptedUniffi_Tags.Decrypted) {
					alerts.normal(i18nT("cannot_decrypt_toast"))

					return
				}

				if (data.previewType === "unknown") {
					const result = await run(async () => {
						return await drive.openLinkedFile({
							linkUuid: data.linkUuid,
							fileKey: data.fileKey
						})
					})

					if (!result.success) {
						console.error(result.error)
						alerts.error(result.error)

						return
					}

					return
				}

				const driveItem = linkedFileIntoDriveItem(data.file)

				if (driveItem.type !== "file") {
					return
				}

				if (driveItem.data.decryptedMeta === null) {
					alerts.normal(i18nT("cannot_decrypt_toast"))

					return
				}

				// We have to set it here since some queries rely on it (e.g. useAudioMetadata)
				cache.uuidToAnyDriveItem.set(driveItem.data.uuid, driveItem)

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
			}}
		>
			{data.type === "directory" ? (
				<Fragment>
					<DirectoryIcon
						width={32}
						height={32}
						color={new DirColor.Default()}
					/>
					<View className="flex-col w-full h-auto bg-transparent">
						<Text
							numberOfLines={1}
							ellipsizeMode="middle"
						>
							{data.info.root.inner.meta.tag === DirMeta_Tags.Decoded
								? data.info.root.inner.meta.inner[0].name
								: cannotDecryptPlaceholder(data.info.root.inner.uuid)}
						</Text>
						<Text className="text-xs text-muted-foreground">
							{simpleDate(
								Number(
									data.info.root.inner.meta.tag === DirMeta_Tags.Decoded && data.info.root.inner.meta.inner[0].created
										? data.info.root.inner.meta.inner[0].created
										: data.info.root.inner.timestamp
								)
							)}
						</Text>
					</View>
				</Fragment>
			) : (
				<Fragment>
					<FileIcon
						width={32}
						height={32}
						name={data.file.name.tag === MaybeEncryptedUniffi_Tags.Decrypted ? data.file.name.inner[0] : data.file.uuid}
					/>
					<View className="flex-col w-full h-auto bg-transparent">
						<Text
							numberOfLines={1}
							ellipsizeMode="middle"
						>
							{data.file.name.tag === MaybeEncryptedUniffi_Tags.Decrypted
								? data.file.name.inner[0]
								: cannotDecryptPlaceholder(data.file.uuid)}
						</Text>
						<Text className="text-xs text-muted-foreground">{formatBytes(Number(data.file.size))}</Text>
					</View>
				</Fragment>
			)}
		</PressableScale>
	)
}

export default InternalAttachment
