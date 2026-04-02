import { Fragment, memo } from "react"
import SafeAreaView from "@/components/ui/safeAreaView"
import Header from "@/components/ui/header"
import View from "@/components/ui/view"
import { ScrollView, Platform, Switch } from "react-native"
import Text from "@/components/ui/text"
import Ionicons from "@expo/vector-icons/Ionicons"
import { useResolveClassNames } from "uniwind"
import { PressableOpacity } from "@/components/ui/pressables"
import { cn } from "@filen/utils"
import { router } from "expo-router"
import Avatar from "@/components/ui/avatar"
import { useStringifiedClient } from "@/lib/auth"
import useContactRequestsQuery from "@/queries/useContactRequests.query"

export type Button = {
	icon?: React.ComponentProps<typeof Ionicons>["name"]
	iconColor?: string
	iconSize?: number
	title: string
	subTitle?: string
	badge?: string | React.ReactNode
	badgeColor?: string
	onPress?: () => void
	rightItem?:
		| {
				type: "switch"
				value: boolean
				onValueChange: (value: boolean) => void
		  }
		| {
				type: "text"
				value: string
		  }
		| {
				type: "badge"
				value: React.ReactNode | string
				color?: string
		  }
}

export const Group = memo(({ buttons, className }: { buttons: Button[]; className?: string }) => {
	const textForeground = useResolveClassNames("text-foreground")
	const textMutedForeground = useResolveClassNames("text-muted-foreground")

	return (
		<View className={cn("bg-background-secondary rounded-3xl overflow-hidden", className)}>
			{buttons.map(({ onPress, icon, iconSize, iconColor, title, subTitle, rightItem, badge, badgeColor }, index) => {
				return (
					<PressableOpacity
						key={index}
						className="bg-transparent flex-row items-center gap-4 px-4"
						onPress={onPress}
						rippleColor={onPress ? undefined : "transparent"}
						enabled={!!onPress}
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
								"bg-transparent flex-row items-center py-3 justify-between flex-1 gap-4",
								index !== buttons.length - 1 && "border-b border-border"
							)}
						>
							{subTitle ? (
								<View className="flex-1 flex-col bg-transparent justify-center">
									<Text
										numberOfLines={1}
										ellipsizeMode="middle"
									>
										{title}
									</Text>
									<Text
										numberOfLines={1}
										ellipsizeMode="middle"
										className="text-muted-foreground text-xs"
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
											"rounded-full size-5 flex-row items-center justify-center",
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
										{typeof badge === "string" ? (
											<Text
												className="text-xs"
												numberOfLines={1}
												ellipsizeMode="middle"
											>
												{badge}
											</Text>
										) : (
											badge
										)}
									</View>
								)}
								{rightItem?.type === "text" && (
									<View className="items-center flex-row bg-transparent max-w-32">
										<Text
											className="text-sm text-muted-foreground"
											numberOfLines={1}
											ellipsizeMode="middle"
										>
											{rightItem.value}
										</Text>
									</View>
								)}
								{rightItem?.type === "badge" && (
									<View
										className={cn(
											"rounded-full size-5 flex-row items-center justify-center",
											!rightItem.color && "bg-red-500"
										)}
										style={
											rightItem.color
												? {
														backgroundColor: rightItem.color
													}
												: undefined
										}
									>
										{typeof rightItem.value === "string" ? (
											<Text
												className="text-white text-xs"
												numberOfLines={1}
												ellipsizeMode="middle"
											>
												{rightItem.value}
											</Text>
										) : (
											rightItem.value
										)}
									</View>
								)}
								{rightItem?.type === "switch" && (
									<View className="items-center flex-row bg-transparent">
										<Switch
											value={rightItem.value}
											onValueChange={rightItem.onValueChange}
										/>
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

const More = memo(() => {
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
				</ScrollView>
			</SafeAreaView>
		</Fragment>
	)
})

export default More
