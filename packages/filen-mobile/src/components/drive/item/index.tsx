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
import { type AnyDirEnumWithShareInfo } from "@filen/sdk-rs"
import { useState } from "react"
import { cn } from "@filen/utils"

const Item = memo(
	({
		info,
		origin
	}: {
		info: ListRenderItemInfo<{
			item: DriveItem
			parent?: AnyDirEnumWithShareInfo
		}>
		origin: DriveItemMenuOrigin
	}) => {
		const textForeground = useResolveClassNames("text-foreground")
		const [isMenuOpen, setIsMenuOpen] = useState<boolean>(false)

		const onPress = useCallback(() => {
			if (info.item.item.type === "directory") {
				if (origin === "offline") {
					router.push({
						pathname: "/offline/[uuid]",
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
		}, [info.item, origin])

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
				>
					<PressableScale
						className="w-full h-auto flex-row"
						onPress={onPress}
					>
						<View className="w-full h-auto flex-row px-4 gap-4 bg-transparent">
							<View className="bg-transparent shrink-0 items-center flex-row">
								{info.item.item.type === "directory" ? (
									<DirectoryIcon
										color={info.item.item.data.color}
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
							<View className="flex-1 flex-row items-center border-b border-border gap-4 py-3 bg-transparent">
								<View className="flex-1 flex-col justify-center gap-0.5 bg-transparent">
									<Text
										numberOfLines={1}
										ellipsizeMode="middle"
										className="text-foreground"
									>
										{info.item.item.data.decryptedMeta?.name}
									</Text>
									<Text
										className="text-xs text-muted-foreground"
										numberOfLines={1}
										ellipsizeMode="middle"
									>
										<Date info={info} /> •{" "}
										<Size
											info={info}
											origin={origin}
										/>
									</Text>
								</View>
								{Platform.OS === "android" && (
									<View className="flex-row items-center shrink-0 bg-transparent">
										<Menu
											type="dropdown"
											isAnchoredToRight={true}
											item={info.item.item}
											parent={info.item.parent}
											origin={origin}
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
