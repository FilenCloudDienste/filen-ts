import Text from "@/components/ui/text"
import View from "@/components/ui/view"
import { DirectoryIcon } from "@/components/itemIcons"
import { DirColor } from "@filen/sdk-rs"
import { driveItemDisplayName } from "@/lib/decryption"
import Thumbnail from "@/features/drive/components/item/thumbnail"
import { useTranslation } from "react-i18next"
import type { DriveItem } from "@/types"

const DriveItemHero = ({ item, size = 128 }: { item: DriveItem; size?: number }) => {
	const { t } = useTranslation()

	return (
		<View className="bg-transparent items-center justify-center flex-col px-4">
			{item.type === "directory" || item.type === "sharedDirectory" || item.type === "sharedRootDirectory" ? (
				<DirectoryIcon
					color={item.type === "directory" ? item.data.color : DirColor.Default.new()}
					width={size}
					height={size}
				/>
			) : (
				<Thumbnail
					item={item}
					size={{
						icon: size,
						thumbnail: size
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
			<Text className="text-muted-foreground">
				{item.type === "directory" || item.type === "sharedDirectory" || item.type === "sharedRootDirectory"
					? t("directory")
					: t("file")}
			</Text>
		</View>
	)
}

export default DriveItemHero
