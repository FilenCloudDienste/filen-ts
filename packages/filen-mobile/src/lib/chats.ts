import auth from "@/lib/auth"
import { type Chat, type ChatMessagePartial, ChatTypingType, type ChatMessage, type Contact, type ChatParticipant } from "@filen/sdk-rs"
import { chatsQueryUpdate, chatsQueryGet, fetchData as chatsQueryFetch } from "@/queries/useChats.query"
import { chatMessagesQueryUpdate, fetchData as chatMessagesQueryFetch } from "@/queries/useChatMessages.query"
import { Semaphore, run } from "@filen/utils"

class Chats {
	private readonly refetchChatsAndMessagesMutex: Semaphore = new Semaphore(1)

	public async listBefore({ chat, before, signal }: { chat: Chat; before: bigint; signal?: AbortSignal }) {
		const { authedSdkClient } = await auth.getSdkClients()

		return await authedSdkClient.listMessagesBefore(
			chat,
			before,
			signal
				? {
						signal
					}
				: undefined
		)
	}

	public async sendMessage({
		chat,
		message,
		replyTo,
		signal,
		inflightId
	}: {
		chat: Chat
		message: string
		replyTo?: ChatMessagePartial
		signal?: AbortSignal
		inflightId: string
	}) {
		const { authedSdkClient } = await auth.getSdkClients()

		await this.sendTyping({
			chat,
			type: ChatTypingType.Up,
			signal
		})

		chat = await authedSdkClient.sendChatMessage(
			chat,
			message,
			replyTo,
			signal
				? {
						signal
					}
				: undefined
		)

		const [[updatedChat]] = await Promise.all([
			this.updateLastFocusTimesNow({
				chats: [chat],
				signal
			}),
			this.markRead({
				chat,
				signal
			})
		])

		if (!updatedChat) {
			throw new Error("Failed to update chat after sending message")
		}

		chat = updatedChat

		chatsQueryUpdate({
			updater: prev => prev.map(c => (c.uuid === chat.uuid ? chat : c))
		})

		const lastMessage = chat.lastMessage

		if (!lastMessage) {
			throw new Error("No last message after sending message")
		}

		chatMessagesQueryUpdate({
			params: {
				uuid: chat.uuid
			},
			updater: prev => [
				...prev.filter(m => m.inner.uuid !== lastMessage.inner.uuid && m.inflightId !== inflightId),
				{
					...lastMessage,
					inflightId
				}
			]
		})

		return {
			chat,
			message: lastMessage
		}
	}

	public async sendTyping({ chat, type, signal }: { chat: Chat; type: ChatTypingType; signal?: AbortSignal }) {
		const { authedSdkClient } = await auth.getSdkClients()

		return await authedSdkClient.sendTypingSignal(
			chat,
			type,
			signal
				? {
						signal
					}
				: undefined
		)
	}

	public async deleteMessage({ chat, message, signal }: { chat: Chat; message: ChatMessage; signal?: AbortSignal }) {
		const { authedSdkClient } = await auth.getSdkClients()

		chat = await authedSdkClient.deleteMessage(
			chat,
			message,
			signal
				? {
						signal
					}
				: undefined
		)

		chatsQueryUpdate({
			updater: prev => prev.map(c => (c.uuid === chat.uuid ? chat : c))
		})

		chatMessagesQueryUpdate({
			params: {
				uuid: chat.uuid
			},
			updater: prev => prev.filter(m => m.inner.uuid !== message.inner.uuid)
		})

		return chat
	}

	public async editMessage({
		chat,
		message,
		newMessage,
		signal
	}: {
		chat: Chat
		message: ChatMessage
		newMessage: string
		signal?: AbortSignal
	}) {
		if (message.inner.message === newMessage) {
			return message
		}

		const { authedSdkClient } = await auth.getSdkClients()

		message = await authedSdkClient.editMessage(
			chat,
			message,
			newMessage,
			signal
				? {
						signal
					}
				: undefined
		)

		chatsQueryUpdate({
			updater: prev =>
				prev.map(c =>
					c.uuid === chat.uuid
						? {
								...chat,
								lastMessage: chat.lastMessage?.inner.uuid === message.inner.uuid ? message : chat.lastMessage
							}
						: c
				)
		})

		chatMessagesQueryUpdate({
			params: {
				uuid: chat.uuid
			},
			updater: prev =>
				prev.map(m =>
					m.inner.uuid === message.inner.uuid
						? {
								...message,
								inflightId: "" // Placeholder, actual inflightId is only needed for send sync
							}
						: m
				)
		})

		return message
	}

	public async disableMessageEmbed({ message, signal }: { message: ChatMessage; signal?: AbortSignal }) {
		if (message.embedDisabled) {
			return message
		}

		const { authedSdkClient } = await auth.getSdkClients()

		message = await authedSdkClient.disableMessageEmbed(
			message,
			signal
				? {
						signal
					}
				: undefined
		)

		const chat = chatsQueryGet()?.find(c => c.uuid === message.chat)

		if (!chat) {
			throw new Error("Chat not found for message")
		}

		chatMessagesQueryUpdate({
			params: {
				uuid: message.chat
			},
			updater: prev =>
				prev.map(m =>
					m.inner.uuid === message.inner.uuid
						? {
								...message,
								inflightId: "" // Placeholder, actual inflightId is only needed for send sync
							}
						: m
				)
		})

		return message
	}

	public async rename({ chat, newName, signal }: { chat: Chat; newName: string; signal?: AbortSignal }) {
		if (chat.name === newName || newName.trim().length === 0) {
			return chat
		}

		const { authedSdkClient } = await auth.getSdkClients()

		chat = await authedSdkClient.renameChat(
			chat,
			newName,
			signal
				? {
						signal
					}
				: undefined
		)

		chatsQueryUpdate({
			updater: prev => prev.map(c => (c.uuid === chat.uuid ? chat : c))
		})

		return chat
	}

	public async leave({ chat, signal }: { chat: Chat; signal?: AbortSignal }) {
		const { authedSdkClient } = await auth.getSdkClients()

		await authedSdkClient.leaveChat(
			chat,
			signal
				? {
						signal
					}
				: undefined
		)

		// We have to set a timeout here, otherwise the main chat _layout redirect kicks in too early and which feels janky and messes with the navigation stack
		setTimeout(() => {
			chatsQueryUpdate({
				updater: prev => prev.filter(c => c.uuid !== chat.uuid)
			})

			chatMessagesQueryUpdate({
				params: {
					uuid: chat.uuid
				},
				updater: () => []
			})
		}, 3000)
	}

	public async delete({ chat, signal }: { chat: Chat; signal?: AbortSignal }) {
		const { authedSdkClient } = await auth.getSdkClients()

		await authedSdkClient.deleteChat(
			chat,
			signal
				? {
						signal
					}
				: undefined
		)

		// We have to set a timeout here, otherwise the main chat _layout redirect kicks in too early and which feels janky and messes with the navigation stack
		setTimeout(() => {
			chatsQueryUpdate({
				updater: prev => prev.filter(c => c.uuid !== chat.uuid)
			})

			chatMessagesQueryUpdate({
				params: {
					uuid: chat.uuid
				},
				updater: () => []
			})
		}, 3000)
	}

	public async mute({ chat, signal, mute }: { chat: Chat; signal?: AbortSignal; mute: boolean }) {
		if (chat.muted === mute) {
			return chat
		}

		const { authedSdkClient } = await auth.getSdkClients()

		chat = await authedSdkClient.muteChat(
			chat,
			mute,
			signal
				? {
						signal
					}
				: undefined
		)

		chatsQueryUpdate({
			updater: prev => prev.map(c => (c.uuid === chat.uuid ? chat : c))
		})

		return chat
	}

	public async create({ contacts, signal }: { contacts: Contact[]; signal?: AbortSignal }) {
		const { authedSdkClient } = await auth.getSdkClients()

		const chat = await authedSdkClient.createChat(
			contacts,
			signal
				? {
						signal
					}
				: undefined
		)

		chatsQueryUpdate({
			updater: prev => [...prev.filter(c => c.uuid !== chat.uuid), chat]
		})

		return chat
	}

	public async addParticipant({ chat, contact, signal }: { chat: Chat; contact: Contact; signal?: AbortSignal }) {
		if (chat.participants.find(p => p.userId === contact.userId)) {
			return chat
		}

		const { authedSdkClient } = await auth.getSdkClients()

		chat = await authedSdkClient.addChatParticipant(
			chat,
			contact,
			signal
				? {
						signal
					}
				: undefined
		)

		chatsQueryUpdate({
			updater: prev => prev.map(c => (c.uuid === chat.uuid ? chat : c))
		})

		return chat
	}

	public async removeParticipant({ chat, participant, signal }: { chat: Chat; participant: ChatParticipant; signal?: AbortSignal }) {
		if (!chat.participants.find(p => p.userId === participant.userId)) {
			return chat
		}

		const { authedSdkClient } = await auth.getSdkClients()

		chat = await authedSdkClient.removeChatParticipant(
			chat,
			participant.userId,
			signal
				? {
						signal
					}
				: undefined
		)

		chatsQueryUpdate({
			updater: prev => prev.map(c => (c.uuid === chat.uuid ? chat : c))
		})

		return chat
	}

	public async markRead({ chat, signal }: { chat: Chat; signal?: AbortSignal }) {
		const { authedSdkClient } = await auth.getSdkClients()

		return await authedSdkClient.markChatRead(
			chat,
			signal
				? {
						signal
					}
				: undefined
		)
	}

	public async updateOnlineStatus({ chat, signal }: { chat: Chat; signal?: AbortSignal }) {
		const { authedSdkClient } = await auth.getSdkClients()

		chat = await authedSdkClient.updateChatOnlineStatus(
			chat,
			signal
				? {
						signal
					}
				: undefined
		)

		chatsQueryUpdate({
			updater: prev => prev.map(c => (c.uuid === chat.uuid ? chat : c))
		})

		return chat
	}

	public async updateLastFocusTimesNow({ chats, signal }: { chats: Chat[]; signal?: AbortSignal }) {
		const { authedSdkClient } = await auth.getSdkClients()

		chats = await authedSdkClient.updateLastChatFocusTimesNow(
			chats,
			signal
				? {
						signal
					}
				: undefined
		)

		for (const chat of chats) {
			chatsQueryUpdate({
				updater: prev => prev.map(c => (c.uuid === chat.uuid ? chat : c))
			})
		}

		return chats
	}

	public async refetchChatsAndMessages() {
		await run(
			async defer => {
				await this.refetchChatsAndMessagesMutex.acquire()

				defer(() => {
					this.refetchChatsAndMessagesMutex.release()
				})

				const chats = await chatsQueryFetch()

				if (!chats || chats.length === 0) {
					return
				}

				await Promise.all(
					chats.map(async chat => {
						const messages = await chatMessagesQueryFetch({
							uuid: chat.uuid
						})

						chatMessagesQueryUpdate({
							params: {
								uuid: chat.uuid
							},
							updater: () => messages
						})
					})
				)

				chatsQueryUpdate({
					updater: () => chats
				})
			},
			{
				throw: true
			}
		)
	}
}

const chats = new Chats()

export default chats
