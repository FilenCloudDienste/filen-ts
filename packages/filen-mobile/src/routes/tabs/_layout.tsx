import { NativeTabs, Icon, Label, VectorIcon, Badge } from "expo-router/unstable-native-tabs"
import MaterialIcons from "@expo/vector-icons/MaterialIcons"
import { Platform } from "react-native"
import { useResolveClassNames } from "uniwind"
import { useIsAuthed } from "@/lib/auth"
import { Redirect } from "expo-router"
import { memo } from "@/lib/memo"
import useChatsUnreadCount from "@/hooks/useChatsUnreadCount"

export const TabsLayout = memo(() => {
	const bgBackground = useResolveClassNames("bg-background")
	const bgBackgroundSecondary = useResolveClassNames("bg-background-secondary")
	const textForeground = useResolveClassNames("text-foreground")
	const textRed500 = useResolveClassNames("text-red-500")
	const isAuthed = useIsAuthed()
	const chatsUnreadCount = useChatsUnreadCount()

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
				<Label>tbd_drive</Label>
				{Platform.select({
					ios: <Icon sf="folder.fill" />,
					default: (
						<Icon
							src={
								<VectorIcon
									family={MaterialIcons}
									name="folder"
								/>
							}
						/>
					)
				})}
			</NativeTabs.Trigger>
			<NativeTabs.Trigger name="photos">
				<Label>tbd_photos</Label>
				{Platform.select({
					ios: <Icon sf="photo.fill" />,
					default: (
						<Icon
							src={
								<VectorIcon
									family={MaterialIcons}
									name="photo-library"
								/>
							}
						/>
					)
				})}
			</NativeTabs.Trigger>
			<NativeTabs.Trigger name="notes">
				<Label>tbd_notes</Label>
				{Platform.select({
					ios: <Icon sf="note.text" />,
					default: (
						<Icon
							src={
								<VectorIcon
									family={MaterialIcons}
									name="book"
								/>
							}
						/>
					)
				})}
			</NativeTabs.Trigger>
			<NativeTabs.Trigger name="chats">
				<Label>tbd_chats</Label>
				{chatsUnreadCount > 0 && <Badge>{chatsUnreadCount.toString()}</Badge>}
				{Platform.select({
					ios: <Icon sf="message.fill" />,
					default: (
						<Icon
							src={
								<VectorIcon
									family={MaterialIcons}
									name="messenger"
								/>
							}
						/>
					)
				})}
			</NativeTabs.Trigger>
			<NativeTabs.Trigger name="more">
				<Label>tbd_more</Label>
				{Platform.select({
					ios: <Icon sf="ellipsis" />,
					default: (
						<Icon
							src={
								<VectorIcon
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
