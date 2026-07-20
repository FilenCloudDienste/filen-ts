import DetailRow from "@/components/ui/detailRow"
import Text from "@/components/ui/text"
import type { DriveItem } from "@/types"
import View from "@/components/ui/view"
import { useResolveClassNames } from "uniwind"
import { formatBytes } from "@filen/utils"
import useDirectorySizeQuery from "@/features/drive/queries/useDirectorySize.query"
import useDriveItemStoredOfflineQuery from "@/features/drive/queries/useDriveItemStoredOffline.query"
import { simpleDate } from "@/lib/time"
import Ionicons from "@expo/vector-icons/Ionicons"
import { getPreviewType } from "@/lib/previewType"
import { driveItemDisplayName } from "@/lib/decryption"
import { useTranslation } from "react-i18next"
import { isFileItem, isDirectoryItem } from "@/features/drive/driveSelectors"
import { rawUploadTimestamp, pickDisplayTimestamp, directorySizeTypeForDrivePath } from "@/features/drive/utils"
import { type DrivePathType } from "@/hooks/useDrivePath"

function OfflineStatusRow({ uuid, type }: { uuid: string; type: DriveItem["type"] }) {
	const textRed500 = useResolveClassNames("text-red-500")
	const textGreen500 = useResolveClassNames("text-green-500")
	const driveItemStoredOfflineQuery = useDriveItemStoredOfflineQuery({ uuid, type })

	return (
		<Ionicons
			name="cloud-download-outline"
			size={16}
			color={
				driveItemStoredOfflineQuery.status === "success" && driveItemStoredOfflineQuery.data ? textGreen500.color : textRed500.color
			}
		/>
	)
}

function useDriveItemInfoRows(
	item: DriveItem,
	linked: boolean | undefined,
	drivePathType: DrivePathType | null | undefined
): { type: string; title: string; value: string | React.ReactNode }[] {
	const { t } = useTranslation()

	const directorySizeQuery = useDirectorySizeQuery(
		{
			uuid: item?.data.uuid ?? "",
			// The sharing role (sharedIn vs sharedOut) and the trash/offline/linked size
			// computation can't be inferred from item.type — they depend on the screen the
			// item is shown in — so derive the query mode from the originating DrivePath.
			type: directorySizeTypeForDrivePath(drivePathType),
			// The info sheet holds the full item — thread it so the size resolves by value even
			// when the session-scoped uuid cache never observed this directory.
			item
		},
		{
			enabled: item !== null && isDirectoryItem(item)
		}
	)

	return (
		[
			{
				type: "type",
				title: t("type"),
				value: isDirectoryItem(item) ? t("directory") : t("file")
			},
			...(isFileItem(item)
				? [
						{
							type: "mime",
							title: t("mime"),
							value: item.data.decryptedMeta?.mime ?? "application/octet-stream"
						},
						{
							type: "previewType",
							title: t("preview_type"),
							value: (() => {
								const previewType = getPreviewType(driveItemDisplayName(item))

								switch (previewType) {
									case "audio": {
										return t("preview_type_audio")
									}

									case "code": {
										return t("preview_type_code")
									}

									case "docx": {
										return t("preview_type_docx")
									}

									case "pdf": {
										return t("preview_type_pdf")
									}

									case "image":
									case "svg": {
										return t("preview_type_image")
									}

									case "text": {
										return t("preview_type_text")
									}

									case "video": {
										return t("preview_type_video")
									}

									case "unknown": {
										return t("preview_type_unknown")
									}
								}
							})()
						}
					]
				: []),
			{
				type: "size",
				title: t("size"),
				value: (() => {
					if (isFileItem(item)) {
						return formatBytes(Number(item.data.size))
					}

					// Gate on data presence, not status: keep the last-known size through a failed
					// refetch (status flips to error while data is retained) and show "..." only while
					// there is genuinely no size yet.
					if (!directorySizeQuery.data) {
						return "..."
					}

					return formatBytes(directorySizeQuery.data.size)
				})()
			},
			...(isDirectoryItem(item)
				? [
						{
							type: "files",
							title: t("files"),
							value: directorySizeQuery.data ? directorySizeQuery.data.files.toString() : "..."
						},
						{
							type: "directories",
							title: t("directories"),
							value: directorySizeQuery.data ? directorySizeQuery.data.dirs.toString() : "..."
						}
					]
				: []),
			{
				type: "created",
				title: t("created"),
				value: (() => {
					if (!item.data.decryptedMeta) {
						return null
					}

					return simpleDate(pickDisplayTimestamp(item.data.decryptedMeta.created, rawUploadTimestamp(item)))
				})()
			},
			{
				type: "modified",
				title: t("modified"),
				value: (() => {
					if (!item.data.decryptedMeta) {
						return null
					}

					// Files carry a distinct `modified` timestamp; directory metas only have
					// `created`, so the "modified" row mirrors `created` for directories
					// (preserves the prior per-type behavior).
					const metaTimestamp = isFileItem(item) ? item.data.decryptedMeta?.modified : item.data.decryptedMeta?.created

					return simpleDate(pickDisplayTimestamp(metaTimestamp, rawUploadTimestamp(item)))
				})()
			},
			{
				type: "uploaded",
				title: t("uploaded"),
				value: (() => {
					if (!item.data.decryptedMeta) {
						return null
					}

					return simpleDate(rawUploadTimestamp(item))
				})()
			},
			...(!linked
				? [
						{
							type: "offline",
							title: t("offline_status"),
							value: (
								<OfflineStatusRow
									uuid={item.data.uuid}
									type={item.type}
								/>
							)
						}
					]
				: [])
		] as const
	).filter(info => info.value !== null)
}

export const Information = ({
	item,
	linked,
	drivePathType
}: {
	item: DriveItem
	linked?: boolean
	drivePathType?: DrivePathType | null
}) => {
	const { t } = useTranslation()
	const info = useDriveItemInfoRows(item, linked, drivePathType)

	return (
		<View className="bg-transparent flex-col gap-2">
			<View className="bg-transparent border-b border-separator pb-2 flex-row items-center justify-between gap-4">
				<Text className="text-lg text-muted-foreground font-bold">{t("information")}</Text>
			</View>
			{info.map(({ type, value, title }) => (
				<DetailRow
					key={type}
					title={title}
					value={value}
				/>
			))}
		</View>
	)
}
