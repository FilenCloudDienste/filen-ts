import { Fragment } from "react"
import SafeAreaView from "@/components/ui/safeAreaView"
import Header from "@/components/ui/header"
import View, { GestureHandlerScrollView } from "@/components/ui/view"
import { Platform, ActivityIndicator } from "react-native"
import * as Linking from "expo-linking"
import Text from "@/components/ui/text"
import Ionicons from "@expo/vector-icons/Ionicons"
import { useResolveClassNames } from "uniwind"
import { PressableScale } from "@/components/ui/pressables"
import { run, formatBytes } from "@filen/utils"
import { router } from "expo-router"
import Avatar from "@/components/ui/avatar"
import { useStringifiedClient } from "@/lib/auth"
import useContactRequestsQuery from "@/features/contacts/queries/useContactRequests.query"
import useAccountQuery from "@/queries/useAccount.query"
import { useTranslation } from "react-i18next"
import { Group, type Button } from "@/components/ui/settingsGroup"
import { LazyWrapper } from "@/components/lazyWrapper"
import StorageUsageBar from "@/features/settings/components/storageUsageBar"
import logger from "@/lib/logger"
import alerts from "@/lib/alerts"

const TERMS_URL = "https://filen.io/terms"
const PRIVACY_URL = "https://filen.io/privacy"

// Dev-only entry into the Developer debug menu (More → Developer). The globalThis read (not bare
// __DEV__) keeps the module safe to evaluate under vitest; in a production build globalThis.__DEV__ is
// false, so the row is never built. See features/settings/screens/developer.
const SHOW_DEVELOPER_MENU = (globalThis as { __DEV__?: boolean }).__DEV__ === true

const DEVELOPER_BUTTONS: Button[] = SHOW_DEVELOPER_MENU
	? [
			{
				icon: "bug-outline",
				title: "Developer",
				onPress: () => {
					router.push("/developer")
				}
			}
		]
	: []

function More() {
	const stringifiedClient = useStringifiedClient()
	const textMutedForeground = useResolveClassNames("text-muted-foreground")
	const { t } = useTranslation()

	const contactRequestsQuery = useContactRequestsQuery({
		enabled: false
	})

	const accountQuery = useAccountQuery()

	const userIsSubbed = accountQuery.status === "success" && accountQuery.data.subs.some(sub => Number(sub.activated) === 1)

	// Muted subtitle under the email: plan tier + total usage ("Pro · 29.5 GB of 45.5 TB"). Plans can
	// be stacked (even different ones) to combine storage, so the tier is just "Pro" (any premium) vs
	// "Free" — never a single plan name. The storage half echoes the bar below as a one-line total.
	const accountSubtitle =
		accountQuery.status === "success"
			? `${userIsSubbed ? t("pro") : t("free_plan")} · ${t("used_of", {
					used: formatBytes(Number(accountQuery.data.storageUsed)),
					max: formatBytes(Number(accountQuery.data.maxStorage))
				})}`
			: null

	// External links (Terms / Privacy) — Linking.openURL is a real app-switch, exempt from
	// withSystemPresentation (it doesn't flash the privacy cover / re-lock biometric). Mirrors the
	// chat link-open pattern (run() + logger.error + alerts.error on failure).
	const openExternalLink = async (url: string) => {
		const result = await run(async () => {
			return await Linking.openURL(url)
		})

		if (!result.success) {
			logger.error("settings", "failed to open external link", {
				url,
				error: result.error instanceof Error ? result.error.message : String(result.error)
			})
			alerts.error(result.error)
		}
	}

	return (
		<Fragment>
			<Header
				title={t("more")}
				shadowVisible={false}
				transparent={Platform.OS === "ios"}
			/>
			<SafeAreaView edges={["left", "right"]}>
				<LazyWrapper>
					<GestureHandlerScrollView
						contentContainerClassName="px-4 gap-4 pb-40"
						contentInsetAdjustmentBehavior="automatic"
					>
						<PressableScale
							className="bg-background-secondary rounded-3xl overflow-hidden gap-3 p-4"
							rippleColor="transparent"
							onPress={() => {
								router.push("/account")
							}}
						>
							<View className="flex-row gap-4 items-center bg-transparent">
								<Avatar
									size={48}
									source={
										accountQuery.status === "success" && accountQuery.data.avatarUrl
											? accountQuery.data.avatarUrl
											: undefined
									}
								/>
								<View className="flex-1 bg-transparent">
									<Text
										numberOfLines={1}
										ellipsizeMode="middle"
										className="text-foreground text-lg font-bold"
									>
										{stringifiedClient?.email}
									</Text>
									{accountSubtitle ? (
										<Text
											numberOfLines={1}
											className="text-muted-foreground text-sm"
										>
											{accountSubtitle}
										</Text>
									) : null}
								</View>
								<Ionicons
									name="chevron-forward-outline"
									size={20}
									color={textMutedForeground.color}
								/>
							</View>
							{accountQuery.status === "success" ? (
								<StorageUsageBar
									storageUsed={accountQuery.data.storageUsed}
									versionedStorage={accountQuery.data.versionedStorage}
									maxStorage={accountQuery.data.maxStorage}
								/>
							) : (
								<ActivityIndicator
									size="small"
									color={textMutedForeground.color}
								/>
							)}
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
									icon: "download-outline",
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
									badge: accountQuery.status === "success" && !accountQuery.data.didExportMasterKeys ? "!" : undefined,
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
								},
								...DEVELOPER_BUTTONS
							]}
						/>
						<Group
							buttons={[
								{
									icon: "document-text-outline",
									title: t("terms_of_service"),
									onPress: () => {
										openExternalLink(TERMS_URL)
									}
								},
								{
									icon: "shield-checkmark-outline",
									title: t("privacy_policy"),
									onPress: () => {
										openExternalLink(PRIVACY_URL)
									}
								}
							]}
						/>
					</GestureHandlerScrollView>
				</LazyWrapper>
			</SafeAreaView>
		</Fragment>
	)
}

export default More
