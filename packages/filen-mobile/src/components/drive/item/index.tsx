import { memo, useCallback } from "@/lib/memo"
import View from "@/components/ui/view"
import { PressableScale } from "@/components/ui/pressables"
import Menu, { type DriveItemMenuOrigin } from "@/components/drive/item/menu"
import { FileIcon, DirectoryIcon } from "@/components/itemIcons"
import Text from "@/components/ui/text"
import { router } from "expo-router"
import type { ListRenderItemInfo } from "@/components/ui/virtualList"
import type { DriveItem } from "@/types"
import Size from "@/components/drive/item/size"
import Ionicons from "@expo/vector-icons/Ionicons"
import { useResolveClassNames } from "uniwind"
import Date from "@/components/drive/item/date"
import { Platform } from "react-native"
import { type AnyDirEnumWithShareInfo, DirColor } from "@filen/sdk-rs"
import { useState } from "react"
import type { DrivePath } from "@/hooks/useDrivePath"
import { cn } from "@filen/utils"
import useDriveItemStoredOfflineQuery from "@/queries/useDriveItemStoredOffline.query"
import useNetInfo from "@/hooks/useNetInfo"
import useDriveStore from "@/stores/useDrive.store"
import useDriveItemVersionsQuery from "@/queries/useDriveItemVersions.query"
import { useShallow } from "zustand/shallow"
import { AnimatedView } from "@/components/ui/animated"
import { FadeIn, FadeOut } from "react-native-reanimated"
import { Checkbox } from "@/components/ui/checkbox"

const Item = memo(
	({
		info,
		origin,
		drivePath
	}: {
		info: ListRenderItemInfo<{
			item: DriveItem
			parent?: AnyDirEnumWithShareInfo
		}>
		origin: DriveItemMenuOrigin
		drivePath: DrivePath
	}) => {
		const textForeground = useResolveClassNames("text-foreground")
		const [isMenuOpen, setIsMenuOpen] = useState<boolean>(false)
		const textGreen500 = useResolveClassNames("text-green-500")
		const textRed500 = useResolveClassNames("text-red-500")
		const netInfo = useNetInfo()
		const isSelected = useDriveStore(
			useShallow(state => state.selectedItems.some(i => i.data.uuid === info.item.item.data.uuid && i.type === info.item.item.type))
		)
		const areDriveItemsSelected = useDriveStore(useShallow(state => state.selectedItems.length > 0))

		const driveItemStoredOfflineQuery = useDriveItemStoredOfflineQuery(
			{
				uuid: info.item.item.data.uuid,
				type: info.item.item.type
			},
			{
				enabled: origin !== "offline"
			}
		)

		const driveItemVersionsQuery = useDriveItemVersionsQuery(
			{
				uuid: info.item.item.data.uuid
			},
			{
				enabled: info.item.item.type === "file" && origin !== "offline"
			}
		)

		const onPress = useCallback(() => {
			if (areDriveItemsSelected) {
				useDriveStore.getState().setSelectedItems(prev => {
					const prevSelected = prev.some(i => i.data.uuid === info.item.item.data.uuid && i.type === info.item.item.type)

					if (prevSelected) {
						return prev.filter(i => !(i.data.uuid === info.item.item.data.uuid && i.type === info.item.item.type))
					}

					return [
						...prev.filter(i => !(i.data.uuid === info.item.item.data.uuid && i.type === info.item.item.type)),
						info.item.item
					]
				})

				return
			}

			if ((info.item.item.type === "directory" || info.item.item.type === "sharedDirectory") && origin !== "trash") {
				if (origin === "offline") {
					router.push({
						pathname: "/offline/[uuid]",
						params: {
							uuid: info.item.item.data.uuid
						}
					})

					return
				}

				if (origin === "sharedIn") {
					router.push({
						pathname: "/sharedIn/[uuid]",
						params: {
							uuid: info.item.item.data.uuid
						}
					})

					return
				}

				if (origin === "sharedOut") {
					router.push({
						pathname: "/sharedOut/[uuid]",
						params: {
							uuid: info.item.item.data.uuid
						}
					})

					return
				}

				router.push({
					pathname: "/tabs/drive/[uuid]",
					params: {
						uuid: info.item.item.data.uuid
					}
				})

				return
			}
		}, [info.item, origin, areDriveItemsSelected])

		return (
			<View
				className={cn(
					"w-full h-auto flex-col",
					isMenuOpen ? (origin === "offline" ? "bg-background-tertiary" : "bg-background-secondary") : "bg-transparent"
				)}
			>
				<Menu
					className="flex-row w-full h-auto"
					type="context"
					isAnchoredToRight={true}
					item={info.item.item}
					parent={info.item.parent}
					origin={origin}
					onCloseMenu={() => setIsMenuOpen(false)}
					onOpenMenu={() => setIsMenuOpen(true)}
					drivePath={drivePath}
					isStoredOffline={driveItemStoredOfflineQuery.status === "success" ? driveItemStoredOfflineQuery.data : false}
					isOnline={netInfo.hasInternet}
					versions={driveItemVersionsQuery.status === "success" ? driveItemVersionsQuery.data : []}
				>
					<PressableScale
						className="w-full h-auto flex-row"
						onPress={onPress}
					>
						<View className="w-full h-auto flex-row px-4 gap-4 bg-transparent">
							{areDriveItemsSelected && (
								<AnimatedView
									className="flex-row h-full items-center justify-center bg-transparent pr-2 shrink-0"
									entering={FadeIn}
									exiting={FadeOut}
								>
									<Checkbox value={isSelected} />
								</AnimatedView>
							)}
							<View className="bg-transparent shrink-0 items-center flex-row">
								{(info.item.item.type === "file" || info.item.item.type === "directory") &&
									info.item.item.data.favorited &&
									origin !== "favorites" && (
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
								{origin !== "offline" &&
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
								{info.item.item.type === "directory" || info.item.item.type === "sharedDirectory" ? (
									<DirectoryIcon
										color={info.item.item.type === "directory" ? info.item.item.data.color : DirColor.Default.new()}
										width={38}
										height={38}
									/>
								) : (
									<FileIcon
										name={info.item.item.data.decryptedMeta?.name ?? ""}
										width={38}
										height={38}
									/>
								)}
							</View>
							<View className="flex-1 flex-row items-center border-b border-border py-3 bg-transparent">
								<View className="flex-1 flex-col justify-center gap-0.5 bg-transparent">
									<Text
										numberOfLines={1}
										ellipsizeMode="middle"
										className="text-foreground"
									>
										{info.item.item.data.decryptedMeta?.name ?? info.item.item.data.uuid}
									</Text>
									<Text
										className="text-xs text-muted-foreground"
										numberOfLines={1}
										ellipsizeMode="middle"
									>
										<Date info={info} />
										<Size
											info={info}
											origin={origin}
										/>
									</Text>
								</View>
								{Platform.OS === "android" && (
									<View className="flex-row items-center shrink-0 bg-transparent pl-4">
										<Menu
											type="dropdown"
											isAnchoredToRight={true}
											item={info.item.item}
											parent={info.item.parent}
											origin={origin}
											drivePath={drivePath}
											isStoredOffline={
												driveItemStoredOfflineQuery.status === "success" ? driveItemStoredOfflineQuery.data : false
											}
											isOnline={netInfo.hasInternet}
											versions={driveItemVersionsQuery.status === "success" ? driveItemVersionsQuery.data : []}
										>
											<Ionicons
												name="ellipsis-horizontal"
												size={20}
												color={textForeground.color}
											/>
										</Menu>
									</View>
								)}
							</View>
						</View>
					</PressableScale>
				</Menu>
			</View>
		)
	}
)

export default Item
