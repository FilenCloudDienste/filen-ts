import { NativeTabs } from "expo-router/unstable-native-tabs"
import MaterialIcons from "@expo/vector-icons/MaterialIcons"
import { Platform } from "react-native"
import { useResolveClassNames, useUniwind } from "uniwind"
import { useIsAuthed } from "@/lib/auth"
import useChatsUnreadCount from "@/features/chats/hooks/useChatsUnreadCount"
import useContactRequestsQuery from "@/features/contacts/queries/useContactRequests.query"
import useAccountQuery from "@/queries/useAccount.query"
import { useTranslation } from "react-i18next"

const TabsLayout = () => {
	const bgBackground = useResolveClassNames("bg-background")
	const bgBackgroundSecondary = useResolveClassNames("bg-background-secondary")
	const textForeground = useResolveClassNames("text-foreground")
	const textRed500 = useResolveClassNames("text-red-500")
	const isAuthed = useIsAuthed()
	const chatsUnreadCount = useChatsUnreadCount()
	const contactRequestsQuery = useContactRequestsQuery()
	// Read-only consumer (enabled: false) — never fetches; reads the SHARED account cache and stays
	// reactive to its updates. The cache is populated + refreshed by accountReminders (at launch) and
	// the More/Security screens, so the badge appears and clears (once the export flips
	// didExportMasterKeys) without the always-mounted tab bar ever fetching.
	const accountQuery = useAccountQuery({
		enabled: false
	})
	const { theme } = useUniwind()
	const { t } = useTranslation()

	if (!isAuthed) {
		return null
	}

	// Master-key export is data-loss-critical, so it claims the More tab's single badge slot;
	// otherwise fall back to the incoming contact-requests count. Both stay badged inside More.
	const keysNotExported = accountQuery.status === "success" && !accountQuery.data.didExportMasterKeys
	const incomingRequests = contactRequestsQuery.status === "success" ? contactRequestsQuery.data.incoming.length : 0
	const moreBadge = keysNotExported ? "!" : incomingRequests > 0 ? incomingRequests.toString() : null

	return (
		<NativeTabs
			backgroundColor={Platform.select({
				ios: undefined,
				default: bgBackground.backgroundColor
			})}
			iconColor={Platform.select({
				ios: theme === "dark" ? "white" : "black",
				default: textForeground.color
			})}
			badgeBackgroundColor={textRed500.color}
			rippleColor={bgBackgroundSecondary.backgroundColor}
			indicatorColor={bgBackgroundSecondary.backgroundColor}
			labelStyle={{
				color: Platform.select({
					ios: theme === "dark" ? "white" : "black",
					default: textForeground.color
				})
			}}
			tintColor={Platform.select({
				ios: theme === "dark" ? "white" : "black",
				default: textForeground.color
			})}
		>
			<NativeTabs.Trigger name="drive">
				<NativeTabs.Trigger.Label>{t("tab_drive")}</NativeTabs.Trigger.Label>
				{Platform.select({
					ios: <NativeTabs.Trigger.Icon sf="folder.fill" />,
					default: (
						<NativeTabs.Trigger.Icon
							src={
								<NativeTabs.Trigger.VectorIcon
									family={MaterialIcons}
									name="folder"
								/>
							}
						/>
					)
				})}
			</NativeTabs.Trigger>
			<NativeTabs.Trigger name="photos">
				<NativeTabs.Trigger.Label>{t("tab_photos")}</NativeTabs.Trigger.Label>
				{Platform.select({
					ios: <NativeTabs.Trigger.Icon sf="photo.fill" />,
					default: (
						<NativeTabs.Trigger.Icon
							src={
								<NativeTabs.Trigger.VectorIcon
									family={MaterialIcons}
									name="photo-library"
								/>
							}
						/>
					)
				})}
			</NativeTabs.Trigger>
			<NativeTabs.Trigger name="notes">
				<NativeTabs.Trigger.Label>{t("tab_notes")}</NativeTabs.Trigger.Label>
				{Platform.select({
					ios: <NativeTabs.Trigger.Icon sf="note.text" />,
					default: (
						<NativeTabs.Trigger.Icon
							src={
								<NativeTabs.Trigger.VectorIcon
									family={MaterialIcons}
									name="book"
								/>
							}
						/>
					)
				})}
			</NativeTabs.Trigger>
			<NativeTabs.Trigger name="chats">
				<NativeTabs.Trigger.Label>{t("tab_chats")}</NativeTabs.Trigger.Label>
				{chatsUnreadCount > 0 && <NativeTabs.Trigger.Badge>{chatsUnreadCount.toString()}</NativeTabs.Trigger.Badge>}
				{Platform.select({
					ios: <NativeTabs.Trigger.Icon sf="message.fill" />,
					default: (
						<NativeTabs.Trigger.Icon
							src={
								<NativeTabs.Trigger.VectorIcon
									family={MaterialIcons}
									name="messenger"
								/>
							}
						/>
					)
				})}
			</NativeTabs.Trigger>
			<NativeTabs.Trigger name="more">
				<NativeTabs.Trigger.Label>{t("tab_more")}</NativeTabs.Trigger.Label>
				{moreBadge !== null && <NativeTabs.Trigger.Badge>{moreBadge}</NativeTabs.Trigger.Badge>}
				{Platform.select({
					ios: <NativeTabs.Trigger.Icon sf="ellipsis" />,
					default: (
						<NativeTabs.Trigger.Icon
							src={
								<NativeTabs.Trigger.VectorIcon
									family={MaterialIcons}
									name="more-horiz"
								/>
							}
						/>
					)
				})}
			</NativeTabs.Trigger>
		</NativeTabs>
	)
}

export default TabsLayout
