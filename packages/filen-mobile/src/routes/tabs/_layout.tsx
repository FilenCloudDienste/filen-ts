import { NativeTabs } from "expo-router/unstable-native-tabs"
import MaterialIcons from "@expo/vector-icons/MaterialIcons"
import { useState } from "react"
import { Platform, type ColorValue } from "react-native"
import { useResolveClassNames } from "uniwind"
import { useIsAuthed } from "@/lib/auth"
import useChatsUnreadCount from "@/features/chats/hooks/useChatsUnreadCount"
import useContactRequestsQuery from "@/features/contacts/queries/useContactRequests.query"
import useAccountQuery from "@/queries/useAccount.query"
import { useTranslation } from "react-i18next"

const TABS = [
	{
		name: "drive",
		labelKey: "tab_drive",
		sf: "folder.fill",
		md: "folder"
	},
	{
		name: "photos",
		labelKey: "tab_photos",
		sf: "photo.fill",
		md: "photo-library"
	},
	{
		name: "notes",
		labelKey: "tab_notes",
		sf: "note.text",
		md: "book"
	},
	{
		name: "chats",
		labelKey: "tab_chats",
		sf: "message.fill",
		md: "messenger"
	},
	{
		name: "more",
		labelKey: "tab_more",
		sf: "ellipsis",
		md: "more-horiz"
	}
] as const

type MaterialIconName = Parameters<typeof MaterialIcons.getImageSource>[0]

// expo-router rasterizes a VectorIcon to a new PNG file in cacheDir on every tab-children change
// (badge, label), and hands native a new URI each time. Reusing the promise keeps the icon's
// identity. Failed loads are evicted so the next conversion retries.
function createCachingMaterialIcons() {
	const cache = new Map<string, ReturnType<typeof MaterialIcons.getImageSource>>()

	return {
		getImageSource: (name: MaterialIconName, size: number, color: ColorValue) => {
			const key = `${name}:${size}:${String(color)}`
			const cached = cache.get(key)

			if (cached) {
				return cached
			}

			const promise = MaterialIcons.getImageSource(name, size, color)

			cache.set(key, promise)

			promise.catch(() => {
				cache.delete(key)
			})

			return promise
		}
	}
}

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
	const { t } = useTranslation()
	// Per mount, never module-level: clearing the cache (manual or on logout) deletes the PNGs.
	// Theme changes and auth flips start a fresh cache, so icons regenerate there as before.
	const iconFamilyKey = `${isAuthed}|${String(textForeground.color)}|${String(bgBackground.backgroundColor)}|${String(bgBackgroundSecondary.backgroundColor)}`
	const [iconFamily, setIconFamily] = useState(() => ({
		key: iconFamilyKey,
		family: createCachingMaterialIcons()
	}))

	if (iconFamily.key !== iconFamilyKey) {
		setIconFamily({
			key: iconFamilyKey,
			family: createCachingMaterialIcons()
		})
	}

	if (!isAuthed) {
		return null
	}

	// Master-key export is data-loss-critical, so it claims the More tab's single badge slot;
	// otherwise fall back to the incoming contact-requests count. Both stay badged inside More.
	// Read the DATA, not the last fetch's verdict (#103): an offline refetch fails and flips
	// `status` to "error" while keeping it. Both badges warn about
	// something real; going offline must not quietly retract the warning.
	const keysNotExported = accountQuery.data ? !accountQuery.data.didExportMasterKeys : false
	const incomingRequests = contactRequestsQuery.data?.incoming.length ?? 0
	const moreBadge = keysNotExported ? "!" : incomingRequests > 0 ? incomingRequests.toString() : null
	const chatsBadge = chatsUnreadCount > 0 ? chatsUnreadCount.toString() : null
	const foreground = textForeground.color

	return (
		<NativeTabs
			backgroundColor={Platform.select({
				ios: undefined,
				default: bgBackground.backgroundColor
			})}
			iconColor={foreground}
			badgeBackgroundColor={textRed500.color}
			rippleColor={bgBackgroundSecondary.backgroundColor}
			indicatorColor={bgBackgroundSecondary.backgroundColor}
			labelStyle={{
				color: foreground
			}}
			tintColor={foreground}
		>
			{TABS.map(tab => {
				const badge = tab.name === "chats" ? chatsBadge : tab.name === "more" ? moreBadge : null

				return (
					<NativeTabs.Trigger
						key={tab.name}
						name={tab.name}
					>
						<NativeTabs.Trigger.Label>{t(tab.labelKey)}</NativeTabs.Trigger.Label>
						{badge !== null && <NativeTabs.Trigger.Badge>{badge}</NativeTabs.Trigger.Badge>}
						{Platform.OS === "ios" ? (
							<NativeTabs.Trigger.Icon sf={tab.sf} />
						) : (
							<NativeTabs.Trigger.Icon
								src={
									<NativeTabs.Trigger.VectorIcon
										family={iconFamily.family}
										name={tab.md}
									/>
								}
							/>
						)}
					</NativeTabs.Trigger>
				)
			})}
		</NativeTabs>
	)
}

export default TabsLayout
