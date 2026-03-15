import { Fragment } from "react"
import SafeAreaView from "@/components/ui/safeAreaView"
import Header from "@/components/ui/header"
import { memo } from "@/lib/memo"
import View from "@/components/ui/view"
import { ScrollView, Platform } from "react-native"
import Text from "@/components/ui/text"
import Ionicons from "@expo/vector-icons/Ionicons"
import { useResolveClassNames } from "uniwind"
import { PressableOpacity } from "@/components/ui/pressables"
import { cn } from "@filen/utils"
import { router } from "expo-router"
import useTransfersStore from "@/stores/useTransfers.store"
import Avatar from "@/components/ui/avatar"
import { useStringifiedClient } from "@/lib/auth"
import { useShallow } from "zustand/shallow"
import useContactRequestsQuery from "@/queries/useContactRequests.query"

export type Button = {
	icon?: React.ComponentProps<typeof Ionicons>["name"]
	iconColor?: string
	iconSize?: number
	title: string
	subTitle?: string
	badge?: string
	badgeColor?: string
	onPress?: () => void
	rightText?: string
}

const Group = memo(({ buttons }: { buttons: Button[] }) => {
	const textForeground = useResolveClassNames("text-foreground")
	const textMutedForeground = useResolveClassNames("text-muted-foreground")

	return (
		<View className="bg-background-secondary rounded-3xl overflow-hidden">
			{buttons.map(({ onPress, icon, iconSize, iconColor, title, subTitle, badge, badgeColor, rightText }, index) => {
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
								{rightText && (
									<View className="items-center flex-row bg-transparent flex-1 max-w-32">
										<Text
											className="text-sm text-muted-foreground"
											numberOfLines={1}
											ellipsizeMode="middle"
										>
											{rightText}
										</Text>
									</View>
								)}
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
	const transfersActiveCount = useTransfersStore(
		useShallow(state => state.transfers.reduce((count, t) => count + (t.finishedAt ? 0 : 1), 0))
	)
	const stringifiedClient = useStringifiedClient()
	const textMutedForeground = useResolveClassNames("text-muted-foreground")

	const contactRequestsQuery = useContactRequestsQuery({
		enabled: false
	})

	return (
		<Fragment>
			<Header
				title="tbd_more"
				transparent={Platform.OS === "ios"}
			/>
			<SafeAreaView edges={["left", "right"]}>
				<ScrollView
					contentContainerClassName="px-4 gap-8 pb-40"
					contentInsetAdjustmentBehavior="automatic"
				>
					<View className="bg-background-secondary rounded-3xl overflow-hidden flex-row gap-4 items-center p-4">
						<Avatar size={64} />
						<View className="flex-1 flex-col bg-transparent justify-center">
							<Text
								numberOfLines={1}
								ellipsizeMode="middle"
								className="text-foreground text-lg font-bold"
							>
								{stringifiedClient?.email}
							</Text>
							<Text
								numberOfLines={1}
								ellipsizeMode="middle"
								className="text-muted-foreground text-sm"
							>
								{stringifiedClient?.userId}
							</Text>
						</View>
						<Ionicons
							name="chevron-forward-outline"
							size={20}
							color={textMutedForeground.color}
						/>
					</View>
					<Group
						buttons={[
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
											uuid: "favorites"
										}
									})
								}
							}
						]}
					/>
					<Group
						buttons={[
							{
								icon: "link-outline",
								title: "tbd_public_links",
								onPress: () => {
									router.push({
										pathname: "/links/[uuid]",
										params: {
											uuid: "links"
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
											uuid: "sharedIn"
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
											uuid: "sharedOut"
										}
									})
								}
							}
						]}
					/>
					<Group
						buttons={[
							{
								icon: "person-outline",
								title: "tbd_contacts",
								badge:
									contactRequestsQuery.status === "success" && contactRequestsQuery.data.incoming.length > 0
										? contactRequestsQuery.data.incoming.length.toString()
										: undefined,
								onPress: () => {
									router.push("/contacts")
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
											uuid: "offline"
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
							}
						]}
					/>
					<Group
						buttons={[
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
