import { Fragment } from "react"
import SafeAreaView from "@/components/ui/safeAreaView"
import Header from "@/components/ui/header"
import { memo } from "@/lib/memo"
import View from "@/components/ui/view"
import { ScrollView } from "react-native"
import Text from "@/components/ui/text"
import Ionicons from "@expo/vector-icons/Ionicons"
import { useResolveClassNames } from "uniwind"
import { PressableOpacity } from "@/components/ui/pressables"
import { cn } from "@filen/utils"
import { router } from "expo-router"
import useTransfersStore from "@/stores/useTransfers.store"
import { useShallow } from "zustand/shallow"

export type Button = {
	icon?: React.ComponentProps<typeof Ionicons>["name"]
	iconColor?: string
	iconSize?: number
	title: string
	subTitle?: string
	badge?: string
	badgeColor?: string
	onPress?: () => void
}

const Group = memo(({ buttons }: { buttons: Button[] }) => {
	const textForeground = useResolveClassNames("text-foreground")
	const textMutedForeground = useResolveClassNames("text-muted-foreground")

	return (
		<View className="bg-background-secondary rounded-3xl overflow-hidden">
			{buttons.map(({ onPress, icon, iconSize, iconColor, title, subTitle, badge, badgeColor }, index) => {
				return (
					<PressableOpacity
						key={index}
						className="bg-transparent flex-row items-center gap-4 px-4"
						onPress={onPress}
					>
						{icon && (
							<View className="bg-transparent flex-row items-center">
								<Ionicons
									name={icon}
									size={iconSize ?? 22}
									color={iconColor ?? textForeground.color}
								/>
							</View>
						)}
						<View
							className={cn(
								"bg-transparent flex-row items-center py-3.5 justify-between flex-1 gap-4  min-h-12",
								index !== buttons.length - 1 && "border-b border-border"
							)}
						>
							{subTitle ? (
								<View className="flex-1 flex-col bg-transparent justify-center">
									<Text
										numberOfLines={1}
										ellipsizeMode="middle"
										className="flex-1"
									>
										{title}
									</Text>
									<Text
										numberOfLines={1}
										ellipsizeMode="middle"
										className="flex-1 text-muted-foreground text-xs"
									>
										{subTitle}
									</Text>
								</View>
							) : (
								<Text
									numberOfLines={1}
									ellipsizeMode="middle"
									className="flex-1"
								>
									{title}
								</Text>
							)}
							<View className="flex-row items-center gap-2 shrink-0 bg-transparent">
								{badge && (
									<View
										className={cn(
											"rounded-full size-4.5 flex-row items-center justify-center",
											!badgeColor && "bg-red-500"
										)}
										style={
											badgeColor
												? {
														backgroundColor: badgeColor
													}
												: undefined
										}
									>
										<Text
											className="text-white text-xs"
											numberOfLines={1}
											ellipsizeMode="middle"
										>
											{badge}
										</Text>
									</View>
								)}
								{onPress && (
									<Ionicons
										className="shrink-0"
										name="chevron-forward-outline"
										size={18}
										color={textMutedForeground.color}
									/>
								)}
							</View>
						</View>
					</PressableOpacity>
				)
			})}
		</View>
	)
})

export const More = memo(() => {
	const transfersActiveCount = useTransfersStore(useShallow(state => state.transfers.filter(t => !t.finishedAt).length))

	return (
		<Fragment>
			<Header title="tbd_more" />
			<SafeAreaView edges={["left", "right"]}>
				<ScrollView contentContainerClassName="px-4 gap-4">
					<View className="bg-background-secondary rounded-3xl overflow-hidden">
						<Text>acc info goes here</Text>
					</View>
					<Group
						buttons={[
							{
								icon: "person-outline",
								title: "tbd_contacts",
								onPress: () => {
									router.push("/contacts")
								}
							},
							{
								icon: "link-outline",
								title: "tbd_public_links",
								onPress: () => {
									router.push({
										pathname: "/links/[uuid]",
										params: {
											uuid: ""
										}
									})
								}
							},
							{
								icon: "time-outline",
								title: "tbd_recents",
								onPress: () => {
									router.push("/recents")
								}
							},
							{
								icon: "heart-outline",
								title: "tbd_favorites",
								onPress: () => {
									router.push({
										pathname: "/favorites/[uuid]",
										params: {
											uuid: ""
										}
									})
								}
							},
							{
								icon: "share-outline",
								title: "tbd_shared_with_me",
								onPress: () => {
									router.push({
										pathname: "/sharedIn/[uuid]",
										params: {
											uuid: ""
										}
									})
								}
							},
							{
								icon: "share-outline",
								title: "tbd_shared_with_others",
								onPress: () => {
									router.push({
										pathname: "/sharedOut/[uuid]",
										params: {
											uuid: ""
										}
									})
								}
							},
							{
								icon: "musical-note-outline",
								title: "tbd_playlists",
								onPress: () => {
									router.push("/playlists")
								}
							},
							{
								icon: "cloud-download-outline",
								title: "tbd_saved_offline",
								onPress: () => {
									router.push({
										pathname: "/offline/[uuid]",
										params: {
											uuid: ""
										}
									})
								}
							},
							{
								icon: "trash-outline",
								title: "tbd_trash",
								onPress: () => {
									router.push("/trash")
								}
							},
							{
								icon: "sync-outline",
								title: "tbd_transfers",
								badge: transfersActiveCount > 0 ? transfersActiveCount.toString() : undefined,
								onPress: () => {
									router.push("/transfers")
								}
							},
							{
								icon: "settings-outline",
								title: "tbd_settings",
								onPress: () => {
									router.push("/settings")
								}
							}
						]}
					/>
				</ScrollView>
			</SafeAreaView>
		</Fragment>
	)
})

export default More
