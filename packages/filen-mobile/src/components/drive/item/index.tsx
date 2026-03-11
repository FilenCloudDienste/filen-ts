import { memo, useCallback, useMemo } from "@/lib/memo"
import View from "@/components/ui/view"
import { PressableScale } from "@/components/ui/pressables"
import Menu, { type DriveItemMenuOrigin } from "@/components/drive/item/menu"
import Text from "@/components/ui/text"
import { router } from "expo-router"
import type { ListRenderItemInfo } from "@/components/ui/virtualList"
import type { DriveItem } from "@/types"
import Size from "@/components/drive/item/size"
import Ionicons from "@expo/vector-icons/Ionicons"
import { useResolveClassNames } from "uniwind"
import Date from "@/components/drive/item/date"
import { Platform } from "react-native"
import { type AnyDirWithContext } from "@filen/sdk-rs"
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
import { Buffer } from "@craftzdog/react-native-buffer"
import { pack } from "@/lib/msgpack"
import useDriveSelectStore from "@/stores/useDriveSelect.store"
import Thumbnail from "@/components/drive/item/thumbnail"

const Item = memo(
	({
		info,
		origin,
		drivePath
	}: {
		info: ListRenderItemInfo<{
			item: DriveItem
			parent?: AnyDirWithContext
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
		const isSelectedFromDriveSelect = useDriveSelectStore(
			useShallow(state => state.selectedItems.some(i => i.data.uuid === info.item.item.data.uuid && i.type === info.item.item.type))
		)
		const selectedItemsFromDriveSelectLength = useDriveSelectStore(useShallow(state => state.selectedItems.length))

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

		const disabled = useMemo(() => {
			if (!drivePath.selectOptions) {
				return false
			}

			switch (drivePath.selectOptions.intention) {
				case "move": {
					return drivePath.selectOptions.items.some(
						i => i.data.uuid === info.item.item.data.uuid && i.type === info.item.item.type
					)
				}

				case "select": {
					const allowedItemTypes: ("file" | "directory")[] = []

					if (drivePath.selectOptions.files) {
						allowedItemTypes.push("file")
					}

					if (drivePath.selectOptions.directories) {
						allowedItemTypes.push("directory")
					}

					const normalizeItemType =
						info.item.item.type === "sharedDirectory" ||
						info.item.item.type === "directory" ||
						info.item.item.type === "sharedRootDirectory"
							? "directory"
							: "file"

					if (!allowedItemTypes.includes(normalizeItemType)) {
						return true
					}

					switch (drivePath.selectOptions.type) {
						case "single": {
							return selectedItemsFromDriveSelectLength > 0 && !isSelectedFromDriveSelect
						}

						case "multiple": {
							return false
						}
					}
				}
			}
		}, [drivePath.selectOptions, info.item, isSelectedFromDriveSelect, selectedItemsFromDriveSelectLength])

		const onPressSelectForDriveSelect = useCallback(() => {
			if (disabled) {
				return
			}

			if (drivePath.selectOptions && drivePath.selectOptions.intention === "select") {
				useDriveSelectStore.getState().setSelectedItems(prev => {
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
		}, [disabled, drivePath.selectOptions, info.item])

		const onPress = useCallback(() => {
			if (disabled) {
				return
			}

			if (isSelectedFromDriveSelect) {
				onPressSelectForDriveSelect()

				return
			}

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

			if (
				(info.item.item.type === "directory" ||
					info.item.item.type === "sharedDirectory" ||
					info.item.item.type === "sharedRootDirectory") &&
				origin !== "trash"
			) {
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

				if (origin === "favorites") {
					router.push({
						pathname: "/favorites/[uuid]",
						params: {
							uuid: info.item.item.data.uuid
						}
					})

					return
				}

				if (origin === "links") {
					router.push({
						pathname: "/links/[uuid]",
						params: {
							uuid: info.item.item.data.uuid
						}
					})

					return
				}

				if (drivePath.selectOptions) {
					router.push({
						pathname: "/driveSelect/[uuid]",
						params: {
							uuid: info.item.item.data.uuid,
							selectOptions: Buffer.from(pack(drivePath.selectOptions)).toString("base64")
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
		}, [
			info.item,
			origin,
			areDriveItemsSelected,
			drivePath.selectOptions,
			isSelectedFromDriveSelect,
			onPressSelectForDriveSelect,
			disabled
		])

		return (
			<View
				className={cn(
					"w-full h-auto flex-row items-center flex-1",
					isMenuOpen ? (origin === "offline" ? "bg-background-tertiary" : "bg-background-secondary") : "bg-transparent",
					disabled && "opacity-50"
				)}
			>
				<Menu
					className="flex-row w-full h-auto flex-1 items-center"
					type="context"
					disabled={!!drivePath.selectOptions}
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
					<View
						className={cn(
							"w-full h-auto flex-row px-4 bg-transparent items-center gap-4",
							areDriveItemsSelected || (drivePath.selectOptions && drivePath.selectOptions.intention === "select" && "pr-14")
						)}
					>
						{areDriveItemsSelected && (
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
									value={isSelectedFromDriveSelect}
									onValueChange={onPressSelectForDriveSelect}
									hitSlop={16}
								/>
							</AnimatedView>
						)}
						<PressableScale
							className="w-full h-auto flex-row gap-4 bg-transparent"
							onPress={onPress}
						>
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
								<Thumbnail
									item={info.item.item}
									size={{
										icon: 38,
										thumbnail: 38
									}}
								/>
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
								{Platform.OS === "android" && !drivePath.selectOptions && (
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
)

export default Item
