import { type Chat } from "@/types"
import View from "@/components/ui/view"
import Text from "@/components/ui/text"
import Image from "@/components/ui/image"
import { customEmojis, type CustomEmoji } from "@/assets/customEmojis"
import { fastLocaleCompare } from "@filen/utils"
import AutocompleteSuggestions from "@/features/chats/components/chat/input/autocompleteSuggestions"

export const EmojiSuggestions = ({ chat }: { chat: Chat }) => {
	const getItems = (text: string): CustomEmoji[] => {
		const textNormalized = text.toLowerCase().trim().split(":").join("")

		return customEmojis
			.filter(e => e.name.toLowerCase().trim().includes(textNormalized))
			.slice(0, 10)
			.sort((a, b) => fastLocaleCompare(a.name, b.name))
	}

	return (
		<AutocompleteSuggestions<CustomEmoji>
			chat={chat}
			kind="emojis"
			trigger=":"
			minLength={3}
			singleTriggerTotalLength={3}
			getItems={getItems}
			buildReplacement={emoji => `:${emoji.name.toLowerCase().trim()}: `}
			itemKey={emoji => emoji.id}
			renderItem={emoji => (
				<View className="flex-row items-center gap-3 bg-transparent py-1.5">
					<Image
						className="shrink-0 w-7 h-7"
						recyclingKey={`emoji-${emoji.id}`}
						source={{
							uri: emoji.skins[0]?.src ?? ""
						}}
					/>
					<View className="bg-transparent flex-1 flex-col">
						<Text
							className="flex-1"
							numberOfLines={1}
							ellipsizeMode="middle"
						>
							{emoji.name}
						</Text>
						<Text
							className="flex-1 text-xs text-muted-foreground"
							numberOfLines={1}
							ellipsizeMode="middle"
						>
							:{emoji.name.toLowerCase()}:
						</Text>
					</View>
				</View>
			)}
		/>
	)
}

export default EmojiSuggestions
