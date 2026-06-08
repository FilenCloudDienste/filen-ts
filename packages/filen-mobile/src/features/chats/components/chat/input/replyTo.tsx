import { type Chat } from "@/types"
import { messageDisplayBody } from "@/lib/decryption"
import { useEffect } from "react"
import View from "@/components/ui/view"
import Text from "@/components/ui/text"
import { useResolveClassNames } from "uniwind"
import Ionicons from "@expo/vector-icons/Ionicons"
import { PressableScale } from "@/components/ui/pressables"
import useChatsStore, { type ChatMessageWithInflightId } from "@/features/chats/store/useChats.store"
import { useShallow } from "zustand/shallow"
import { useSecureStore } from "@/lib/secureStore"
import { contactDisplayName } from "@/lib/utils"
import { useTranslation } from "react-i18next"
import Avatar from "@/components/ui/avatar"
import PopupContainerView from "@/features/chats/components/chat/input/popupContainerView"
import { resolveReplySenderDisplayName } from "@/features/chats/utils"

export const ReplyTo = ({ chat }: { chat: Chat }) => {
	const [chatReplyTo, setChatReplyTo] = useSecureStore<ChatMessageWithInflightId | null>(`chatReplyTo:${chat.uuid}`, null)
	const suggestionsVisible = useChatsStore(useShallow(state => state.suggestionsVisible))
	const textMutedForeground = useResolveClassNames("text-muted-foreground")
	const { t } = useTranslation()

	const info = ((): { show: false } | { show: true; displayName: string } => {
		if (!chatReplyTo || suggestionsVisible.filter(s => s !== "reply").length > 0) {
			return {
				show: false
			}
		}

		const participant = chat.participants.find(p => p.userId === chatReplyTo.inner.senderId)

		const displayName = participant
			? contactDisplayName(participant)
			: resolveReplySenderDisplayName(chatReplyTo.inner.senderNickName, chatReplyTo.inner.senderEmail, t("unknown"))

		return {
			show: true,
			displayName
		}
	})()

	useEffect(() => {
		if (info.show) {
			useChatsStore.getState().setSuggestionsVisible(prev => [...prev.filter(s => s !== "reply"), "reply"])
		} else {
			useChatsStore.getState().setSuggestionsVisible(prev => prev.filter(s => s !== "reply"))
		}
	}, [info.show])

	if (!info.show || !chatReplyTo) {
		return null
	}

	return (
		<PopupContainerView
			scrollViewClassName="py-1"
			scrollViewProps={{
				scrollEnabled: false
			}}
		>
			<View className="flex-row items-center gap-3 bg-transparent py-1.5">
				<View className="flex-row items-center gap-3 bg-transparent">
					<Ionicons
						size={20}
						name="arrow-undo-outline"
						color={textMutedForeground.color}
						style={{
							transform: [
								{
									scaleX: -1
								}
							]
						}}
					/>
					<Avatar
						className="shrink-0"
						size={32}
						source={chatReplyTo?.inner.senderAvatar}
					/>
				</View>
				<View className="bg-transparent flex-1 flex-col">
					<Text
						className="flex-1"
						numberOfLines={1}
						ellipsizeMode="middle"
					>
						{info.displayName}
					</Text>
					<Text
						className="flex-1 text-xs text-muted-foreground"
						numberOfLines={1}
						ellipsizeMode="tail"
					>
						{messageDisplayBody(chatReplyTo)}
					</Text>
				</View>
				<PressableScale
					className="flex-row items-center justify-center"
					onPress={() => {
						setChatReplyTo(null)
					}}
				>
					<Ionicons
						name="close-outline"
						size={20}
						color={textMutedForeground.color}
					/>
				</PressableScale>
			</View>
		</PopupContainerView>
	)
}

export default ReplyTo
