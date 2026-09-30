import { Fragment } from "react"
import SafeAreaView from "@/components/ui/safeAreaView"
import Header from "@/components/ui/header"
import View, { GestureHandlerScrollView } from "@/components/ui/view"
import { Platform, ActivityIndicator } from "react-native"
import Text from "@/components/ui/text"
import Ionicons from "@expo/vector-icons/Ionicons"
import { useResolveClassNames } from "uniwind"
import { PressableScale } from "@/components/ui/pressables"
import { formatBytes } from "@filen/shared"
import { router } from "@/lib/router"
import Avatar from "@/components/ui/avatar"
import { useStringifiedClient } from "@/lib/auth"
import useContactRequestsQuery from "@/features/contacts/queries/useContactRequests.query"
import useAccountQuery from "@/queries/useAccount.query"
import { useTranslation } from "react-i18next"
import { Group, type Button } from "@/components/ui/settingsGroup"
import { LazyWrapper } from "@/components/lazyWrapper"
import StorageUsageBar from "@/features/settings/components/storageUsageBar"
import { openTrustedUrl } from "@/lib/openTrustedUrl"

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
				href: "/developer"
			}
		]
	: []

// The uuid segment is a placeholder: useDrivePath resolves a non-uuid segment to the virtual root.
function driveListingHref(type: "favorites" | "offline" | "links" | "sharedIn" | "sharedOut") {
	return {
		pathname: `/${type}/[uuid]` as const,
		params: {
			uuid: type
		}
	}
}

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
										accountQuery.data?.avatarUrl ? accountQuery.data.avatarUrl : undefined
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
							{accountQuery.data ? (
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
									href: "/recents"
								},
								{
									icon: "heart-outline",
									title: t("favorites"),
									href: driveListingHref("favorites")
								},
								{
									icon: "cloud-download-outline",
									title: t("saved_offline"),
									href: driveListingHref("offline")
								},
								{
									icon: "trash-outline",
									title: t("trash"),
									href: "/trash"
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
												href: driveListingHref("links")
											} satisfies Button
										]
									: []),
								{
									icon: "download-outline",
									title: t("shared_with_me"),
									href: driveListingHref("sharedIn")
								},
								{
									icon: "share-outline",
									title: t("shared_with_others"),
									href: driveListingHref("sharedOut")
								}
							]}
						/>
						<Group
							buttons={[
								{
									icon: "person-outline",
									title: t("contacts"),
									// Read the DATA, not the last fetch's verdict (#103) — the badge survives going offline.
									badge:
										contactRequestsQuery.data && contactRequestsQuery.data.incoming.length > 0
											? contactRequestsQuery.data.incoming.length.toString()
											: undefined,
									href: "/contacts"
								},
								{
									icon: "musical-note-outline",
									title: t("playlists"),
									href: "/playlists"
								}
							]}
						/>
						<Group
							buttons={[
								{
									icon: "lock-closed-outline",
									title: t("security"),
									// Data-loss warning — it must not disappear just because the device is offline (#103).
									badge: accountQuery.data && !accountQuery.data.didExportMasterKeys ? "!" : undefined,
									href: "/security"
								},
								{
									icon: "folder-open-outline",
									title: Platform.OS === "ios" ? t("file_provider") : t("documents_provider"),
									href: "/fileProvider"
								},
								{
									icon: "cloud-offline-outline",
									title: t("offline"),
									href: "/offlineSettings"
								},
								{
									icon: "color-palette-outline",
									title: t("appearance"),
									href: "/appearance"
								},
								{
									icon: "list-outline",
									title: t("events"),
									href: "/events"
								},
								{
									icon: "build-outline",
									title: t("advanced"),
									href: "/advanced"
								},
								...DEVELOPER_BUTTONS
							]}
						/>
						<Group
							buttons={[
								{
									icon: "code-slash-outline",
									title: t("third_party_notices"),
									href: "/thirdPartyNotices"
								},
								{
									icon: "document-text-outline",
									title: t("terms_of_service"),
									onPress: () => {
										openTrustedUrl("settings", TERMS_URL)
									}
								},
								{
									icon: "shield-checkmark-outline",
									title: t("privacy_policy"),
									onPress: () => {
										openTrustedUrl("settings", PRIVACY_URL)
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
