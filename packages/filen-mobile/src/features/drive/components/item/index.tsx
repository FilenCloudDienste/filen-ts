import View from "@/components/ui/view"
import { PressableScale } from "@/components/ui/pressables"
import Menu from "@/features/drive/components/item/menu"
import Text from "@/components/ui/text"
import { router } from "expo-router"
import type { ListRenderItemInfo } from "@/components/ui/virtualList"
import type { DriveItem } from "@/types"
import Size from "@/features/drive/components/item/size"
import Ionicons from "@expo/vector-icons/Ionicons"
import { useResolveClassNames } from "uniwind"
import Date from "@/features/drive/components/item/date"
import { Platform } from "react-native"
import type { DrivePath } from "@/hooks/useDrivePath"
import { cn } from "@filen/utils"
import useDriveItemStoredOfflineQuery from "@/features/drive/queries/useDriveItemStoredOffline.query"
import useDriveStore from "@/features/drive/store/useDrive.store"
import { useShallow } from "zustand/shallow"
import { AnimatedView } from "@/components/ui/animated"
import { FadeIn, FadeOut } from "react-native-reanimated"
import { Checkbox } from "@/components/ui/checkbox"
import useDriveSelectStore from "@/features/drive/store/useDriveSelect.store"
import Thumbnail from "@/features/drive/components/item/thumbnail"
import { useRecyclingState } from "@shopify/flash-list"
import useDrivePreviewStore from "@/stores/useDrivePreview.store"
import { getPreviewType } from "@/lib/previewType"
import { driveItemDisplayName } from "@/lib/decryption"
import { isDriveItemDisabled, isDriveItemNavigateOnly, resolveDriveNavigationTarget } from "@/features/drive/driveSelectors"
import useOfflineStore from "@/features/offline/store/useOffline.store"
import { useTranslation } from "react-i18next"
import { hairlineBorderBottom } from "@/lib/hairline"

const Item = ({
	info,
	drivePath,
	getListItems
}: {
	info: ListRenderItemInfo<DriveItem>
	drivePath: DrivePath
	getListItems: () => DriveItem[]
}) => {
	const { t } = useTranslation()
	const textForeground = useResolveClassNames("text-foreground")
	const [isMenuOpen, setIsMenuOpen] = useRecyclingState<boolean>(false, [info.item.data.uuid])
	const textGreen500 = useResolveClassNames("text-green-500")
	const textRed500 = useResolveClassNames("text-red-500")
	const isSelected = useDriveStore(
		useShallow(state => state.selectedItems.some(i => i.data.uuid === info.item.data.uuid && i.type === info.item.type))
	)
	const areDriveItemsSelected = useDriveStore(useShallow(state => state.selectedItems.length > 0))
	const isSelectedFromDriveSelect = useDriveSelectStore(
		useShallow(state => state.selectedItems.some(i => i.data.uuid === info.item.data.uuid && i.type === info.item.type))
	)
	const selectedItemsFromDriveSelectLength = useDriveSelectStore(useShallow(state => state.selectedItems.length))
	const previewType =
		info.item.type === "file" || info.item.type === "sharedFile" || info.item.type === "sharedRootFile"
			? getPreviewType(driveItemDisplayName(info.item))
			: null

	const driveItemStoredOfflineQuery = useDriveItemStoredOfflineQuery({
		uuid: info.item.data.uuid,
		type: info.item.type
	})

	// Offline listing only: whether the last sync pass recorded an error for this item —
	// either directly (itemUuid) or for anything nested inside it (topLevelUuid). Surfaced
	// as a textual indicator line (rows already carry a file/dir icon, so no second icon).
	const hasOfflineSyncError = useOfflineStore(
		state =>
			drivePath.type === "offline" &&
			state.syncErrors.some(e => e.itemUuid === info.item.data.uuid || e.topLevelUuid === info.item.data.uuid)
	)

	const disabled = isDriveItemDisabled({
		item: info.item,
		drivePath,
		previewType,
		selectedFromDriveSelectCount: selectedItemsFromDriveSelectLength,
		isSelectedFromDriveSelect
	})

	const navigateOnly = isDriveItemNavigateOnly({
		item: info.item,
		drivePath,
		disabled
	})

	const onPressSelectForDriveSelect = () => {
		if (disabled) {
			return
		}

		if (drivePath.selectOptions && drivePath.selectOptions.intention === "select") {
			useDriveSelectStore.getState().setSelectedItems(prev => {
				const prevSelected = prev.some(i => i.data.uuid === info.item.data.uuid && i.type === info.item.type)

				if (prevSelected) {
					return prev.filter(i => !(i.data.uuid === info.item.data.uuid && i.type === info.item.type))
				}

				return [...prev.filter(i => !(i.data.uuid === info.item.data.uuid && i.type === info.item.type)), info.item]
			})

			return
		}
	}

	const onPress = () => {
		// Undecryptable items have no meaningful preview or navigation target —
		// suppress the open intent so the row stays inert. Selection still works
		// because that path goes through the Checkbox / Menu Select button.
		if (info.item.data.undecryptable) {
			return
		}

		if (disabled && !navigateOnly) {
			return
		}

		if (!navigateOnly) {
			if (isSelectedFromDriveSelect) {
				onPressSelectForDriveSelect()

				return
			}

			if (areDriveItemsSelected) {
				useDriveStore.getState().setSelectedItems(prev => {
					const prevSelected = prev.some(i => i.data.uuid === info.item.data.uuid)

					if (prevSelected) {
						return prev.filter(i => i.data.uuid !== info.item.data.uuid)
					}

					return [...prev.filter(i => i.data.uuid !== info.item.data.uuid), info.item]
				})

				return
			}

			if (info.item.type === "file" || info.item.type === "sharedFile" || info.item.type === "sharedRootFile") {
				useDrivePreviewStore.getState().open({
					initialItem: {
						type: "drive",
						data: {
							item: info.item,
							drivePath
						}
					},
					items: getListItems()
						.filter(i => i.type === "file" || i.type === "sharedFile" || i.type === "sharedRootFile")
						.map(item => ({
							type: "drive",
							data: item
						}))
				})

				return
			}
		}

		const navigationTarget = resolveDriveNavigationTarget({
			item: info.item,
			drivePath
		})

		if (navigationTarget) {
			router.push(navigationTarget)

			return
		}
	}

	return (
		<View
			className={cn(
				"w-full h-auto flex-row items-center flex-1",
				isMenuOpen ? (drivePath.type === "offline" ? "bg-background-tertiary" : "bg-background-secondary") : "bg-transparent",
				disabled && !navigateOnly && "opacity-50"
			)}
		>
			<Menu
				className="flex-row w-full h-auto flex-1 items-center"
				type="context"
				disabled={!!drivePath.selectOptions}
				isAnchoredToRight={true}
				item={info.item}
				onCloseMenu={() => setIsMenuOpen(false)}
				onOpenMenu={() => setIsMenuOpen(true)}
				drivePath={drivePath}
				isStoredOffline={driveItemStoredOfflineQuery.status === "success" ? driveItemStoredOfflineQuery.data : false}
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
							{(info.item.type === "file" || info.item.type === "directory") &&
								info.item.data.favorited &&
								drivePath.type !== "favorites" && (
									<View className="bg-transparent flex-row items-center justify-center absolute bottom-1 -right-2.5 z-10">
										<View className="bg-background-tertiary rounded-full p-0.5 flex-row items-center justify-center">
											<Ionicons
												name="heart"
												size={16}
												color={textRed500.color}
											/>
										</View>
									</View>
								)}
							{drivePath.type !== "offline" &&
								driveItemStoredOfflineQuery.status === "success" &&
								driveItemStoredOfflineQuery.data && (
									<View className="bg-transparent flex-row items-center justify-center absolute bottom-1 -left-2.5 z-10">
										<View className="bg-background-tertiary rounded-full p-0.5 flex-row items-center justify-center">
											<Ionicons
												name="download-outline"
												size={16}
												color={textGreen500.color}
											/>
										</View>
									</View>
								)}
							<Thumbnail
								item={info.item}
								target={info.target}
								size={{
									icon: 38,
									thumbnail: 38
								}}
							/>
						</View>
						<View
							className="flex-1 flex-row items-center border-separator py-3 bg-transparent"
							style={hairlineBorderBottom}
						>
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
								{hasOfflineSyncError && (
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
										isStoredOffline={
											driveItemStoredOfflineQuery.status === "success" ? driveItemStoredOfflineQuery.data : false
										}
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
