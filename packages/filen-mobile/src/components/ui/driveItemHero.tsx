import Text from "@/components/ui/text"
import View from "@/components/ui/view"
import { DirectoryIcon } from "@/components/itemIcons"
import { DirColor } from "@filen/sdk-rs"
import { driveItemDisplayName } from "@/lib/decryption"
import Thumbnail from "@/features/drive/components/item/thumbnail"
import { useTranslation } from "react-i18next"
import type { DriveItem } from "@/types"
import { isDirectoryItem } from "@/features/drive/driveSelectors"

const DriveItemHero = ({ item }: { item: DriveItem }) => {
	const { t } = useTranslation()

	return (
		<View className="bg-transparent items-center justify-center flex-col px-4">
			{isDirectoryItem(item) ? (
				<DirectoryIcon
					color={item.type === "directory" ? item.data.color : DirColor.Default.new()}
					width={128}
					height={128}
				/>
			) : (
				<Thumbnail
					item={item}
					size={{
						icon: 128,
						thumbnail: 128
					}}
					contentFit="cover"
					className="rounded-3xl"
				/>
			)}
			<Text
				className="text-lg font-bold mt-4"
				numberOfLines={1}
				ellipsizeMode="middle"
			>
				{driveItemDisplayName(item)}
			</Text>
			<Text className="text-muted-foreground">{isDirectoryItem(item) ? t("directory") : t("file")}</Text>
		</View>
	)
}

export default DriveItemHero
