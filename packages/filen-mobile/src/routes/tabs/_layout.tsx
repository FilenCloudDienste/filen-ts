import { NativeTabs } from "expo-router/unstable-native-tabs"
import MaterialIcons from "@expo/vector-icons/MaterialIcons"
import { Platform } from "react-native"
import { useResolveClassNames } from "uniwind"
import { useIsAuthed } from "@/lib/auth"
import { Redirect } from "expo-router"
import { memo } from "@/lib/memo"
import useChatsUnreadCount from "@/hooks/useChatsUnreadCount"
import useContactRequestsQuery from "@/queries/useContactRequests.query"

export const TabsLayout = memo(() => {
	const bgBackground = useResolveClassNames("bg-background")
	const bgBackgroundSecondary = useResolveClassNames("bg-background-secondary")
	const textForeground = useResolveClassNames("text-foreground")
	const textRed500 = useResolveClassNames("text-red-500")
	const isAuthed = useIsAuthed()
	const chatsUnreadCount = useChatsUnreadCount()
	const contactRequestsQuery = useContactRequestsQuery()

	if (!isAuthed) {
		return <Redirect href="/auth/login" />
	}

	return (
		<NativeTabs
			backgroundColor={bgBackground.backgroundColor}
			iconColor={textForeground.color}
			badgeBackgroundColor={textRed500.color}
			rippleColor={bgBackgroundSecondary.backgroundColor}
			indicatorColor={bgBackgroundSecondary.backgroundColor}
			tintColor={textForeground.color}
		>
			<NativeTabs.Trigger name="drive">
				<NativeTabs.Trigger.Label>tbd_drive</NativeTabs.Trigger.Label>
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
				<NativeTabs.Trigger.Label>tbd_photos</NativeTabs.Trigger.Label>
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
				<NativeTabs.Trigger.Label>tbd_notes</NativeTabs.Trigger.Label>
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
				<NativeTabs.Trigger.Label>tbd_chats</NativeTabs.Trigger.Label>
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
				<NativeTabs.Trigger.Label>tbd_more</NativeTabs.Trigger.Label>
				{contactRequestsQuery.status === "success" && contactRequestsQuery.data.incoming.length > 0 && (
					<NativeTabs.Trigger.Badge>{contactRequestsQuery.data.incoming.length.toString()}</NativeTabs.Trigger.Badge>
				)}
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
})

export default TabsLayout
