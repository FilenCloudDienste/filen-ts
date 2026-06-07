import { Fragment } from "react"
import SafeAreaView from "@/components/ui/safeAreaView"
import Header from "@/components/ui/header"
import View, { GestureHandlerScrollView } from "@/components/ui/view"
import { Platform, ActivityIndicator } from "react-native"
import Text from "@/components/ui/text"
import Ionicons from "@expo/vector-icons/Ionicons"
import { useResolveClassNames } from "uniwind"
import { PressableScale } from "@/components/ui/pressables"
import { formatBytes } from "@filen/utils"
import { router } from "expo-router"
import Avatar from "@/components/ui/avatar"
import { useStringifiedClient } from "@/lib/auth"
import useContactRequestsQuery from "@/features/contacts/queries/useContactRequests.query"
import useAccountQuery from "@/queries/useAccount.query"
import { useTranslation } from "react-i18next"
import { Group, type Button } from "@/components/ui/settingsGroup"

function More() {
	const stringifiedClient = useStringifiedClient()
	const textMutedForeground = useResolveClassNames("text-muted-foreground")
	const { t } = useTranslation()

	const contactRequestsQuery = useContactRequestsQuery({
		enabled: false
	})

	const accountQuery = useAccountQuery()

	const userIsSubbed = accountQuery.status === "success" && accountQuery.data.subs.some(sub => Number(sub.activated) === 1)

	return (
		<Fragment>
			<Header
				title={t("more")}
				transparent={Platform.OS === "ios"}
			/>
			<SafeAreaView edges={["left", "right"]}>
				<GestureHandlerScrollView
					contentContainerClassName="px-4 gap-4 pb-40"
					contentInsetAdjustmentBehavior="automatic"
				>
					<PressableScale
						className="bg-background-secondary rounded-3xl overflow-hidden flex-row gap-4 items-center p-4"
						rippleColor="transparent"
						onPress={() => {
							router.push("/account")
						}}
					>
						<Avatar
							size={48}
							source={
								accountQuery.status === "success" && accountQuery.data.avatarUrl ? accountQuery.data.avatarUrl : undefined
							}
						/>
						<View className="flex-1 flex-col bg-transparent justify-center">
							<Text
								numberOfLines={1}
								ellipsizeMode="middle"
								className="text-foreground text-lg font-bold"
							>
								{stringifiedClient?.email}
							</Text>
							{accountQuery.status === "success" ? (
								<Text
									numberOfLines={1}
									ellipsizeMode="middle"
									className="text-muted-foreground text-sm"
								>
									{t("used_of", {
										used: formatBytes(Number(accountQuery.data.storageUsed)),
										max: formatBytes(Number(accountQuery.data.maxStorage))
									})}
								</Text>
							) : (
								<ActivityIndicator
									size="small"
									color={textMutedForeground.color}
								/>
							)}
						</View>
						<Ionicons
							name="chevron-forward-outline"
							size={20}
							color={textMutedForeground.color}
						/>
					</PressableScale>
					<Group
						buttons={[
							{
								icon: "time-outline",
								title: t("recents"),
								onPress: () => {
									router.push("/recents")
								}
							},
							{
								icon: "heart-outline",
								title: t("favorites"),
								onPress: () => {
									router.push({
										pathname: "/favorites/[uuid]",
										params: {
											uuid: "favorites"
										}
									})
								}
							},
							{
								icon: "cloud-download-outline",
								title: t("saved_offline"),
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
								title: t("trash"),
								onPress: () => {
									router.push("/trash")
								}
							}
						]}
					/>
					<Group
						buttons={[
							...(userIsSubbed
								? [
										{
											icon: "link-outline",
											title: t("public_links"),
											onPress: () => {
												router.push({
													pathname: "/links/[uuid]",
													params: {
														uuid: "links"
													}
												})
											}
										} satisfies Button
									]
								: []),
							{
								icon: "share-outline",
								title: t("shared_with_me"),
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
								title: t("shared_with_others"),
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
								title: t("contacts"),
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
								title: t("playlists"),
								onPress: () => {
									router.push("/playlists")
								}
							}
						]}
					/>
					<Group
						buttons={[
							{
								icon: "lock-closed-outline",
								title: t("security"),
								onPress: () => {
									router.push("/security")
								}
							},
							{
								icon: "folder-open-outline",
								title: Platform.OS === "ios" ? t("file_provider") : t("documents_provider"),
								onPress: () => {
									router.push("/fileProvider")
								}
							},
							{
								icon: "cloud-offline-outline",
								title: t("offline"),
								onPress: () => {
									router.push("/offlineSettings")
								}
							},
							{
								icon: "color-palette-outline",
								title: t("appearance"),
								onPress: () => {
									router.push("/appearance")
								}
							},
							{
								icon: "list-outline",
								title: t("events"),
								onPress: () => {
									router.push("/events")
								}
							},
							{
								icon: "build-outline",
								title: t("advanced"),
								onPress: () => {
									router.push("/advanced")
								}
							}
						]}
					/>
				</GestureHandlerScrollView>
			</SafeAreaView>
		</Fragment>
	)
}

export default More
