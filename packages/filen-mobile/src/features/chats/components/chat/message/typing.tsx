import { useTranslation } from "react-i18next"
import { type Chat as TChat } from "@/types"
import View from "@/components/ui/view"
import Text from "@/components/ui/text"
import { AnimatedView } from "@/components/ui/animated"
import { FadeIn } from "react-native-reanimated"
import useChatsStore from "@/features/chats/store/useChats.store"
import { useShallow } from "zustand/shallow"
import { typingLabel, typingNames } from "@/features/chats/utils"

export const Typing = ({ chat }: { chat: TChat }) => {
	const { t } = useTranslation()
	const typing = useChatsStore(useShallow(state => state.typing[chat.uuid] ?? []))

	const users = typingNames(typing, chat.participants)

	if (users.length === 0) {
		return null
	}

	return (
		<AnimatedView
			entering={FadeIn.delay(100)}
			className="w-full h-auto pb-2 px-4 items-start"
		>
			<View className="p-3 rounded-3xl max-w-3/4 bg-background-secondary">
				<Text className="text-xs">{typingLabel(users, t)}</Text>
			</View>
		</AnimatedView>
	)
}

export default Typing
