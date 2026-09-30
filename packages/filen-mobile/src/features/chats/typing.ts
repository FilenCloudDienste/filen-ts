import { ChatTypingType } from "@filen/sdk-rs"
import { createTypingSender } from "@filen/shared"
import { type Chat } from "@/types"
import chats from "@/features/chats/chats"
import logger from "@/lib/logger"

export const { signalTyping, signalStopped } = createTypingSender<Chat>({
	keyOf: chat => chat.uuid,
	send: async (chat, type) => {
		await chats.sendTyping({
			chat,
			type: type === "down" ? ChatTypingType.Down : ChatTypingType.Up
		})
	},
	onError: (_chat, _type, e) => {
		logger.warn("chats", "sendTypingEvent failed", { error: e })
	}
})
