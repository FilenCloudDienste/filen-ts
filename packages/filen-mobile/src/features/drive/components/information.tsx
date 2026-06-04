import Text from "@/components/ui/text"
import type { DriveItem } from "@/types"
import View from "@/components/ui/view"
import { memo } from "react"
import { useResolveClassNames } from "uniwind"
import { formatBytes } from "@filen/utils"
import useDirectorySizeQuery from "@/features/drive/queries/useDirectorySize.query"
import useDriveItemStoredOfflineQuery from "@/features/drive/queries/useDriveItemStoredOffline.query"
import { simpleDate } from "@/lib/time"
import Ionicons from "@expo/vector-icons/Ionicons"
import { getPreviewType } from "@/lib/utils"
import { driveItemDisplayName } from "@/lib/decryption"
import { useTranslation } from "react-i18next"

export const Information = memo(({ item, linked }: { item: DriveItem; linked?: boolean }) => {
	const textRed500 = useResolveClassNames("text-red-500")
	const textGreen500 = useResolveClassNames("text-green-500")
	const { t } = useTranslation()

	const directorySizeQuery = useDirectorySizeQuery(
		{
			uuid: item?.data.uuid ?? "",
			// TODO: Fix type for shared in/out based on sharing role
			type:
				item.type === "sharedDirectory" ||
				item.type === "sharedFile" ||
				item.type === "sharedRootFile" ||
				item.type === "sharedRootDirectory"
					? "sharedOut"
					: "normal"
		},
		{
			enabled: item !== null && (item.type === "directory" || item.type === "sharedDirectory" || item.type === "sharedRootDirectory")
		}
	)

	const driveItemStoredOfflineQuery = useDriveItemStoredOfflineQuery({
		uuid: item?.data.uuid ?? "",
		type: item?.type ?? "file"
	})

	// TODO: extract to function and clean up
	const info: {
		type: string
		title: string
		value: string | React.ReactNode
	}[] = (
		[
			{
				type: "type",
				title: t("type"),
				value:
					item.type === "directory" || item.type === "sharedDirectory" || item.type === "sharedRootDirectory"
						? t("directory")
						: t("file")
			},
			...(item.type === "file" || item.type === "sharedFile" || item.type === "sharedRootFile"
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

									case "image": {
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
					switch (item.type) {
						case "file":
						case "sharedFile":
						case "sharedRootFile": {
							return formatBytes(Number(item.data.size))
						}

						case "directory":
						case "sharedDirectory":
						case "sharedRootDirectory": {
							if (directorySizeQuery.status !== "success") {
								return "..."
							}

							return formatBytes(directorySizeQuery.data.size)
						}
					}
				})()
			},
			...(item.type === "directory" || item.type === "sharedDirectory" || item.type === "sharedRootDirectory"
				? [
						{
							type: "files",
							title: t("files"),
							value: directorySizeQuery.status === "success" ? directorySizeQuery.data.files.toString() : "..."
						},
						{
							type: "directories",
							title: t("directories"),
							value: directorySizeQuery.status === "success" ? directorySizeQuery.data.dirs.toString() : "..."
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

					switch (item.type) {
						case "file": {
							if (!item.data.decryptedMeta.created) {
								return simpleDate(Number(item.data.timestamp))
							}

							return simpleDate(Number(item.data.decryptedMeta.created))
						}

						case "sharedFile":
						case "sharedRootFile": {
							if (!item.data.decryptedMeta.created) {
								return simpleDate(Number(item.data.timestamp))
							}

							return simpleDate(Number(item.data.decryptedMeta.created))
						}

						case "directory": {
							if (!item.data.decryptedMeta.created) {
								return simpleDate(Number(item.data.timestamp))
							}

							return simpleDate(Number(item.data.decryptedMeta.created))
						}

						case "sharedDirectory": {
							if (!item.data.decryptedMeta.created) {
								return simpleDate(Number(item.data.inner.timestamp))
							}

							return simpleDate(Number(item.data.decryptedMeta.created))
						}

						case "sharedRootDirectory": {
							if (!item.data.decryptedMeta.created) {
								return simpleDate(Number(item.data.inner.timestamp))
							}

							return simpleDate(Number(item.data.decryptedMeta.created))
						}
					}
				})()
			},
			{
				type: "modified",
				title: t("modified"),
				value: (() => {
					if (!item.data.decryptedMeta) {
						return null
					}

					switch (item.type) {
						case "file": {
							if (!item.data.decryptedMeta.modified) {
								return simpleDate(Number(item.data.timestamp))
							}

							return simpleDate(Number(item.data.decryptedMeta.modified))
						}

						case "sharedFile":
						case "sharedRootFile": {
							if (!item.data.decryptedMeta.modified) {
								return simpleDate(Number(item.data.timestamp))
							}

							return simpleDate(Number(item.data.decryptedMeta.modified))
						}

						case "directory": {
							if (!item.data.decryptedMeta.created) {
								return simpleDate(Number(item.data.timestamp))
							}

							return simpleDate(Number(item.data.decryptedMeta.created))
						}

						case "sharedDirectory": {
							if (!item.data.decryptedMeta.created) {
								return simpleDate(Number(item.data.inner.timestamp))
							}

							return simpleDate(Number(item.data.decryptedMeta.created))
						}

						case "sharedRootDirectory": {
							if (!item.data.decryptedMeta.created) {
								return simpleDate(Number(item.data.inner.timestamp))
							}

							return simpleDate(Number(item.data.decryptedMeta.created))
						}
					}
				})()
			},
			{
				type: "uploaded",
				title: t("uploaded"),
				value: (() => {
					if (!item.data.decryptedMeta) {
						return null
					}

					switch (item.type) {
						case "file":
						case "sharedFile":
						case "sharedRootFile": {
							return simpleDate(Number(item.data.timestamp))
						}

						case "directory": {
							return simpleDate(Number(item.data.timestamp))
						}

						case "sharedRootDirectory":
						case "sharedDirectory": {
							return simpleDate(Number(item.data.inner.timestamp))
						}
					}
				})()
			},
			...(!linked
				? [
						{
							type: "offline",
							title: t("offline_status"),
							value: (
								<Ionicons
									name="cloud-download-outline"
									size={16}
									color={
										driveItemStoredOfflineQuery.status === "success" && driveItemStoredOfflineQuery.data
											? textGreen500.color
											: textRed500.color
									}
								/>
							)
						}
					]
				: [])
		] as const
	).filter(info => info.value !== null)

	return (
		<View className="bg-transparent flex-col gap-2">
			<View className="bg-transparent border-b border-border pb-2 flex-row items-center justify-between gap-4">
				<Text className="text-lg text-muted-foreground font-bold">{t("information")}</Text>
			</View>
			{info.map(({ type, value, title }) => (
				<View
					key={type}
					className="bg-transparent border-b border-border pb-2 flex-row items-center justify-between gap-4"
				>
					<Text
						className="text-muted-foreground shrink-0"
						numberOfLines={1}
						ellipsizeMode="middle"
					>
						{title}
					</Text>
					<View className="bg-transparent flex-1 justify-end items-center flex-row gap-2">
						{typeof value === "string" ? (
							<Text
								className="text-foreground flex-1 text-right"
								numberOfLines={1}
								ellipsizeMode="middle"
							>
								{value}
							</Text>
						) : (
							value
						)}
					</View>
				</View>
			))}
		</View>
	)
})
