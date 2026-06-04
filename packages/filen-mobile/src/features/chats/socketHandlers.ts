import { ChatEvent_Tags, ChatTypingType, MaybeEncryptedUniffi_Tags, SocketEvent_Tags, type SocketEvent } from "@filen/sdk-rs"
import useChatsStore from "@/features/chats/store/useChats.store"
import { chatMessagesQueryUpdate, chatMessagesQueryGet } from "@/features/chats/queries/useChatMessages.query"
import { chatsQueryGet, chatsQueryUpdate } from "@/features/chats/queries/useChats.query"
import events from "@/lib/events"

export type ChatSocketEvent = Extract<SocketEvent, { tag: typeof SocketEvent_Tags.Chat }>

export const chatTypingTimeoutsRef: Record<number, NodeJS.Timeout> = {}

export async function handleChatEvent({ event, userId }: { event: ChatSocketEvent; userId: bigint }): Promise<void> {
	const [eventInner] = event.inner

	switch (eventInner.inner.tag) {
		case ChatEvent_Tags.Typing: {
			const [inner] = eventInner.inner.inner

			clearTimeout(chatTypingTimeoutsRef[Number(inner.senderId)])

			useChatsStore.getState().setTyping(prev => {
				switch (inner.typingType) {
					case ChatTypingType.Down: {
						chatTypingTimeoutsRef[Number(inner.senderId)] = setTimeout(() => {
							useChatsStore.getState().setTyping(prev => ({
								...prev,
								[inner.chat]: (prev[inner.chat] ?? []).filter(t => t.senderId !== inner.senderId)
							}))
						}, 10000)

						return {
							...prev,
							[inner.chat]: [...(prev[inner.chat] ?? []).filter(t => t.senderId !== inner.senderId), inner]
						}
					}

					case ChatTypingType.Up: {
						return {
							...prev,
							[inner.chat]: (prev[inner.chat] ?? []).filter(t => t.senderId !== inner.senderId)
						}
					}
				}
			})

			break
		}

		case ChatEvent_Tags.MessageNew: {
			const [inner] = eventInner.inner.inner

			clearTimeout(chatTypingTimeoutsRef[Number(inner.msg.inner.senderId)])

			useChatsStore.getState().setTyping(prev => ({
				...prev,
				[inner.msg.chat]: (prev[inner.msg.chat] ?? []).filter(t => t.senderId !== inner.msg.inner.senderId)
			}))

			setTimeout(
				() => {
					chatMessagesQueryUpdate({
						params: {
							uuid: inner.msg.chat
						},
						updater: prev => [
							...prev.filter(m => m.inner.uuid !== inner.msg.inner.uuid),
							{
								...inner.msg,
								inflightId: "", // Placeholder, actual inflightId is only needed for send sync
								undecryptable: inner.msg.inner.message === undefined
							}
						]
					})

					// Update messages query first, then chats query to ensure our unread count logic works correctly
					setTimeout(() => {
						chatsQueryUpdate({
							updater: prev =>
								prev.map(c =>
									c.uuid === inner.msg.chat
										? {
												...c,
												lastMessage: inner.msg
											}
										: c
								)
						})
					}, 1)
				},
				// We delay this slightly to ensure local updates process first when sending a message
				userId === inner.msg.inner.senderId ? 3000 : 1
			)

			break
		}

		case ChatEvent_Tags.ConversationNameEdited: {
			const [inner] = eventInner.inner.inner

			switch (inner.newName.tag) {
				case MaybeEncryptedUniffi_Tags.Decrypted: {
					const [name] = inner.newName.inner

					chatsQueryUpdate({
						updater: prev =>
							prev.map(c =>
								c.uuid === inner.chat
									? {
											...c,
											name
										}
									: c
							)
					})
				}
			}

			break
		}

		case ChatEvent_Tags.MessageEdited: {
			const [inner] = eventInner.inner.inner

			switch (inner.newContent.tag) {
				case MaybeEncryptedUniffi_Tags.Decrypted: {
					const [newContent] = inner.newContent.inner

					chatMessagesQueryUpdate({
						params: {
							uuid: inner.chat
						},
						updater: prev =>
							prev.map(m =>
								m.inner.uuid === inner.uuid
									? {
											...m,
											inner: {
												...m.inner,
												message: newContent
											}
										}
									: m
							)
					})
				}
			}

			break
		}

		case ChatEvent_Tags.MessageDelete: {
			const [inner] = eventInner.inner.inner

			const chats = chatsQueryGet()
			const chat = chats?.find(c => {
				const messages = chatMessagesQueryGet({
					uuid: c.uuid
				})

				return messages?.some(m => m.inner.uuid === inner.uuid)
			})

			if (!chat) {
				break
			}

			chatMessagesQueryUpdate({
				params: {
					uuid: chat.uuid
				},
				updater: prev => prev.filter(m => m.inner.uuid !== inner.uuid)
			})

			break
		}

		case ChatEvent_Tags.MessageEmbedDisabled: {
			const [inner] = eventInner.inner.inner

			const chats = chatsQueryGet()
			const chat = chats?.find(c => {
				const messages = chatMessagesQueryGet({
					uuid: c.uuid
				})

				return messages?.some(m => m.inner.uuid === inner.uuid)
			})

			if (!chat) {
				break
			}

			chatMessagesQueryUpdate({
				params: {
					uuid: chat.uuid
				},
				updater: prev =>
					prev.map(m =>
						m.inner.uuid === inner.uuid
							? {
									...m,
									inner: {
										...m.inner,
										embedsDisabled: true
									}
								}
							: m
					)
			})

			break
		}

		case ChatEvent_Tags.ConversationsNew: {
			const [inner] = eventInner.inner.inner

			chatsQueryUpdate({
				updater: prev => [
					...(prev ?? []).filter(c => c.uuid !== inner.chat.uuid),
					{
						...inner.chat,
						undecryptable: inner.chat.key === undefined
					}
				]
			})

			break
		}

		case ChatEvent_Tags.ConversationDeleted: {
			const [inner] = eventInner.inner.inner

			const chats = chatsQueryGet()
			const chat = chats?.find(c => c.uuid === inner.uuid)

			if (!chat) {
				break
			}

			events.emit("chatConversationDeleted", {
				uuid: inner.uuid
			})

			// We have to set a timeout here, otherwise the main chat _layout redirect kicks in too early and which feels janky and messes with the navigation stack if we are inside the chat when this happen.
			// This is a bit of a band-aid solution, ideally we would have a more robust way to handle this, but it works for now and the delay is short enough that it shouldn't cause any issues.
			setTimeout(() => {
				chatMessagesQueryUpdate({
					params: {
						uuid: inner.uuid
					},
					updater: () => []
				})

				chatsQueryUpdate({
					updater: prev => (prev ?? []).filter(c => c.uuid !== inner.uuid)
				})
			}, 3000)

			break
		}

		case ChatEvent_Tags.ConversationParticipantLeft: {
			const [inner] = eventInner.inner.inner

			const chats = chatsQueryGet()
			const chat = chats?.find(c => c.uuid === inner.uuid)

			if (!chat) {
				break
			}

			chatsQueryUpdate({
				updater: prev =>
					prev.map(c =>
						c.uuid === inner.uuid
							? {
									...c,
									participants: c.participants.filter(p => p.userId !== inner.userId)
								}
							: c
					)
			})

			break
		}

		case ChatEvent_Tags.ConversationParticipantNew: {
			const [inner] = eventInner.inner.inner

			const chats = chatsQueryGet()
			const chat = chats?.find(c => c.uuid === inner.chat)

			if (!chat) {
				break
			}

			chatsQueryUpdate({
				updater: prev =>
					prev.map(c =>
						c.uuid === inner.chat
							? {
									...c,
									participants: [...c.participants.filter(p => p.userId !== inner.participant.userId), inner.participant]
								}
							: c
					)
			})

			break
		}

		default: {
			console.error(eventInner)

			throw new Error("Unhandled chat event")
		}
	}
}
