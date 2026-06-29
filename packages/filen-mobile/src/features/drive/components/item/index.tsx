import View from "@/components/ui/view"
import { PressableScale } from "@/components/ui/pressables"
import Menu from "@/features/drive/components/item/menu"
import Text from "@/components/ui/text"
import type { ListRenderItemInfo } from "@/components/ui/virtualList"
import type { DriveItem } from "@/types"
import Size from "@/features/drive/components/item/size"
import Ionicons from "@expo/vector-icons/Ionicons"
import { useResolveClassNames } from "uniwind"
import Date from "@/features/drive/components/item/date"
import ShareEmail from "@/features/drive/components/item/shareEmail"
import { Platform } from "react-native"
import type { DrivePath } from "@/hooks/useDrivePath"
import { cn } from "@filen/utils"
import { AnimatedView } from "@/components/ui/animated"
import { FadeIn, FadeOut } from "react-native-reanimated"
import { Checkbox } from "@/components/ui/checkbox"
import { useRecyclingState } from "@shopify/flash-list"
import Thumbnail from "@/features/drive/components/item/thumbnail"
import { FavoritedIndicator, OfflineIndicator } from "@/features/drive/components/item/indicators"
import useDriveItemInteraction from "@/features/drive/hooks/useDriveItemInteraction"
import useDriveItemIndicators from "@/features/drive/hooks/useDriveItemIndicators"
import { driveItemDisplayName } from "@/lib/decryption"
import { useTranslation } from "react-i18next"

const Item = ({
	info,
	drivePath,
	getListItems,
	searchParentPath
}: {
	info: ListRenderItemInfo<DriveItem>
	drivePath: DrivePath
	getListItems: () => DriveItem[]
	// Cache-search only: the hit's parent path relative to the search root. When non-empty, the
	// row shows the item's full relative path as a third line. Undefined in normal browsing.
	searchParentPath?: string
}) => {
	const { t } = useTranslation()
	const textForeground = useResolveClassNames("text-foreground")
	const [isMenuOpen, setIsMenuOpen] = useRecyclingState<boolean>(false, [info.item.data.uuid])
	const {
		onPress,
		disabled,
		navigateOnly,
		isSelected,
		areDriveItemsSelected,
		isSelectedFromDriveSelect,
		onPressSelectForDriveSelect
	} = useDriveItemInteraction({ info, drivePath, getListItems })
	const { showFavorited, showOffline, isStoredOffline, hasSyncError } = useDriveItemIndicators({
		item: info.item,
		drivePath
	})

	return (
		<View
			className={cn(
				"w-full h-auto flex-row items-center flex-1",
				Platform.OS === "android" && isMenuOpen
					? drivePath.type === "offline"
						? "bg-background-tertiary"
						: "bg-background-secondary"
					: "bg-transparent",
				disabled && !navigateOnly && "opacity-50"
			)}
		>
			<Menu
				className="flex-row w-full h-auto flex-1 items-center"
				type="context"
				disabled={!!drivePath.selectOptions}
				isAnchoredToRight={true}
				previewBackground={true}
				item={info.item}
				onCloseMenu={() => setIsMenuOpen(false)}
				onOpenMenu={() => setIsMenuOpen(true)}
				drivePath={drivePath}
				isStoredOffline={isStoredOffline}
			>
				<View
					className={cn(
						"w-full h-auto flex-row px-4 bg-transparent items-center gap-4",
						areDriveItemsSelected || (drivePath.selectOptions && drivePath.selectOptions.intention === "select" && "pr-14")
					)}
				>
					{areDriveItemsSelected && !drivePath.selectOptions && (
						<AnimatedView
							className="flex-row h-full items-center justify-center bg-transparent shrink-0"
							entering={FadeIn}
							exiting={FadeOut}
						>
							<Checkbox
								value={isSelected}
								onValueChange={onPress}
								hitSlop={16}
							/>
						</AnimatedView>
					)}
					{drivePath.selectOptions && drivePath.selectOptions.intention === "select" && (
						<AnimatedView
							className="flex-row h-full items-center justify-center bg-transparent shrink-0"
							entering={FadeIn}
							exiting={FadeOut}
						>
							<Checkbox
								value={disabled ? false : isSelectedFromDriveSelect}
								onValueChange={disabled ? undefined : onPressSelectForDriveSelect}
								hitSlop={16}
								color={disabled ? "transparent" : undefined}
							/>
						</AnimatedView>
					)}
					<PressableScale
						className="w-full h-auto flex-row gap-4 bg-transparent"
						onPress={onPress}
					>
						<View className="bg-transparent shrink-0 items-center flex-row">
							{showFavorited && <FavoritedIndicator />}
							{showOffline && <OfflineIndicator />}
							<Thumbnail
								item={info.item}
								target={info.target}
								size={{
									icon: 38,
									thumbnail: 38
								}}
							/>
						</View>
						<View className="flex-1 flex-row items-center border-b border-separator py-3 bg-transparent">
							<View className="flex-1 flex-col justify-center gap-0.5 bg-transparent">
								<Text
									numberOfLines={1}
									ellipsizeMode="middle"
									className="text-foreground"
								>
									{driveItemDisplayName(info.item)}
								</Text>
								<Text
									className="text-xs text-muted-foreground"
									numberOfLines={1}
									ellipsizeMode="middle"
								>
									<Date info={info} />
									<Size
										info={info}
										drivePath={drivePath}
									/>
								</Text>
								{searchParentPath !== undefined && searchParentPath.length > 0 && (
									<Text
										className="text-xs text-muted-foreground"
										numberOfLines={1}
										ellipsizeMode="head"
									>
										{`${searchParentPath}/${driveItemDisplayName(info.item)}`}
									</Text>
								)}
								<ShareEmail
									info={info}
									drivePath={drivePath}
								/>
								{hasSyncError && (
									<Text
										className="text-xs text-red-500"
										numberOfLines={1}
										ellipsizeMode="middle"
									>
										{t("offline_sync_failed")}
									</Text>
								)}
							</View>
							{Platform.OS === "android" && !drivePath.selectOptions && (
								<View className="flex-row items-center shrink-0 bg-transparent pl-4">
									<Menu
										type="dropdown"
										isAnchoredToRight={true}
										item={info.item}
										drivePath={drivePath}
										isStoredOffline={isStoredOffline}
									>
										<View className="pl-4 h-full items-center justify-center flex-row bg-transparent">
											<Ionicons
												name="ellipsis-horizontal"
												size={20}
												color={textForeground.color}
											/>
										</View>
									</Menu>
								</View>
							)}
						</View>
					</PressableScale>
				</View>
			</Menu>
		</View>
	)
}

export default Item
