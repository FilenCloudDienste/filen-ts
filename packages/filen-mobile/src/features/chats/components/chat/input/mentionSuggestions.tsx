import { type ChatParticipant } from "@filen/sdk-rs"
import { type Chat } from "@/types"
import View from "@/components/ui/view"
import Text from "@/components/ui/text"
import Avatar from "@/components/ui/avatar"
import { useStringifiedClient } from "@/lib/auth"
import { contactDisplayName } from "@/lib/utils"
import { fastLocaleCompare } from "@filen/utils"
import AutocompleteSuggestions from "@/features/chats/components/chat/input/autocompleteSuggestions"

export const MentionSuggestions = ({ chat }: { chat: Chat }) => {
	const stringifiedClient = useStringifiedClient()

	const getItems = (text: string): ChatParticipant[] => {
		const textNormalized = text.toLowerCase().trim().slice(1)

		return chat.participants
			.filter(p => {
				if (p.userId === stringifiedClient?.userId) {
					return false
				}

				if (textNormalized.length === 0) {
					return true
				}

				return (
					contactDisplayName(p).toLowerCase().trim().includes(textNormalized) ||
					p.email.toLowerCase().trim().includes(textNormalized)
				)
			})
			.sort((a, b) => fastLocaleCompare(contactDisplayName(a), contactDisplayName(b)))
	}

	return (
		<AutocompleteSuggestions<ChatParticipant>
			chat={chat}
			kind="mentions"
			trigger="@"
			minLength={1}
			singleTriggerTotalLength={1}
			getItems={getItems}
			buildReplacement={participant => `@${participant.email} `}
			itemKey={participant => participant.userId.toString()}
			renderItem={participant => (
				<View className="flex-row items-center gap-3 bg-transparent py-1.5">
					<Avatar
						className="shrink-0"
						size={28}
						source={participant.avatar}
					/>
					<View className="bg-transparent flex-1 flex-col">
						<Text
							className="flex-1"
							numberOfLines={1}
							ellipsizeMode="middle"
						>
							{contactDisplayName(participant)}
						</Text>
						<Text
							className="flex-1 text-xs text-muted-foreground"
							numberOfLines={1}
							ellipsizeMode="middle"
						>
							{participant.email}
						</Text>
					</View>
				</View>
			)}
		/>
	)
}

export default MentionSuggestions
