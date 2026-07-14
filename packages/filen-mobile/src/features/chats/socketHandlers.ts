import { ChatEvent_Tags, ChatTypingType, MaybeEncryptedUniffi_Tags, SocketEvent_Tags, type SocketEvent } from "@filen/sdk-rs"
import useChatsStore from "@/features/chats/store/useChats.store"
import { chatMessagesQueryUpdate, chatMessagesQueryGet } from "@/features/chats/queries/useChatMessages.query"
import { chatsQueryGet, chatsQueryUpdate } from "@/features/chats/queries/useChats.query"
import { wrapChat, wrapMessage } from "@/features/chats/chatsWrap"
import events from "@/lib/events"
import cache from "@/lib/cache"
import { purgeChatInflightState } from "@/features/chats/chatsInflight"
import logger from "@/lib/logger"

export type ChatSocketEvent = Extract<SocketEvent, { tag: typeof SocketEvent_Tags.Chat }>

// Keyed by `${chatUuid}:${senderId}` — NOT by senderId alone. The same sender can be typing in
// multiple chats at once (group chats), so a global-per-sender key would let a Typing/MessageNew
// event in one chat cancel/overwrite the auto-clear watchdog armed for that sender in another chat,
// stranding a "typing…" indicator forever when the first chat's Typing.Up is dropped.
export const chatTypingTimeoutsRef: Record<string, NodeJS.Timeout> = {}

function typingTimeoutKey(chatUuid: string, senderId: bigint): string {
	return `${chatUuid}:${senderId}`
}

// Removes every local trace of a chat this account can no longer access — shared by
// ConversationDeleted and by ConversationParticipantLeft when the leaver is ourselves (left from
// another device/session). Returns false when the chats query doesn't know the chat (the inflight
// purge still runs).
async function removeChatLocally(uuid: string): Promise<boolean> {
	// Purge the chat's queued unsent messages, send errors and input drafts immediately (D4b/M5) —
	// the sync must never retry into a deleted chat, and a disk-restored queue could reference a
	// chat the query cache doesn't even know about, so this runs unconditionally before the cache
	// lookup below. Best-effort (never throws).
	await purgeChatInflightState(uuid)

	const chats = chatsQueryGet()
	const chat = chats?.find(c => c.uuid === uuid)

	if (!chat) {
		return false
	}

	events.emit("chatConversationDeleted", {
		uuid
	})

	// Purge the chat from the selection immediately so the list selection state (header count,
	// deselect-all condition, bulk ops) never targets a non-existent conversation while the user
	// stays on the chats tab. The query cache removal below is deferred, but the selection must
	// not lag behind.
	useChatsStore.getState().setSelectedChats(prev => prev.filter(c => c.uuid !== uuid))

	// We have to set a timeout here, otherwise the main chat _layout redirect kicks in too early and which feels janky and messes with the navigation stack if we are inside the chat when this happen.
	// This is a bit of a band-aid solution, ideally we would have a more robust way to handle this, but it works for now and the delay is short enough that it shouldn't cause any issues.
	setTimeout(() => {
		chatMessagesQueryUpdate({
			params: {
				uuid
			},
			updater: () => []
		})

		chatsQueryUpdate({
			updater: prev => (prev ?? []).filter(c => c.uuid !== uuid)
		})
	}, 3000)

	return true
}

export async function handleChatEvent({ event, userId }: { event: ChatSocketEvent; userId: bigint }): Promise<void> {
	const [eventInner] = event.inner

	switch (eventInner.inner.tag) {
		case ChatEvent_Tags.Typing: {
			const [inner] = eventInner.inner.inner
			const timeoutKey = typingTimeoutKey(inner.chat, inner.senderId)

			clearTimeout(chatTypingTimeoutsRef[timeoutKey])
			delete chatTypingTimeoutsRef[timeoutKey]

			useChatsStore.getState().setTyping(prev => {
				switch (inner.typingType) {
					case ChatTypingType.Down: {
						chatTypingTimeoutsRef[timeoutKey] = setTimeout(() => {
							delete chatTypingTimeoutsRef[timeoutKey]

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
			const messageTimeoutKey = typingTimeoutKey(inner.msg.chat, inner.msg.inner.senderId)

			clearTimeout(chatTypingTimeoutsRef[messageTimeoutKey])
			delete chatTypingTimeoutsRef[messageTimeoutKey]

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
						// Dedupe by server uuid: if the message is already present (e.g. chats.sendMessage already
						// reconciled the optimistic in-flight copy into the cache for our own message), leave it
						// untouched instead of removing and re-appending it, which would cause a brief duplicate.
						updater: prev =>
							prev.some(m => m.inner.uuid === inner.msg.inner.uuid)
								? prev
								: [
										...prev,
										{
											...wrapMessage(inner.msg),
											inflightId: "" // Placeholder, actual inflightId is only needed for send sync
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

					break
				}

				default: {
					logger.warn("chats", "ConversationNameEdited: received encrypted name, skipping cache update", { chatUuid: inner.chat })
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

					// If the edited message is the chat's lastMessage, the chats-list preview reads it from the
					// SEPARATE chats query — mirror the new content there too, or the list keeps the old text.
					chatsQueryUpdate({
						updater: prev =>
							prev.map(c =>
								c.uuid === inner.chat && c.lastMessage?.inner.uuid === inner.uuid
									? {
											...c,
											lastMessage: {
												...c.lastMessage,
												inner: {
													...c.lastMessage.inner,
													message: newContent
												}
											}
										}
									: c
							)
					})

					break
				}

				default: {
					logger.warn("chats", "MessageEdited: received encrypted content, skipping cache update", { chatUuid: inner.chat, msgUuid: inner.uuid })
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
				logger.warn("chats", "MessageDelete: message not found in cache", { msgUuid: inner.uuid })

				break
			}

			chatMessagesQueryUpdate({
				params: {
					uuid: chat.uuid
				},
				updater: prev => prev.filter(m => m.inner.uuid !== inner.uuid)
			})

			// If the deleted message was the chat's lastMessage, the chats-list preview (a SEPARATE query)
			// would keep showing the deleted text — recompute it to the newest remaining message (or null).
			if (chat.lastMessage?.inner.uuid === inner.uuid) {
				const remaining = chatMessagesQueryGet({ uuid: chat.uuid }) ?? []
				const newLast = remaining.reduce<(typeof remaining)[number] | null>(
					(latest, m) => (!latest || m.sentTimestamp > latest.sentTimestamp ? m : latest),
					null
				)

				chatsQueryUpdate({
					updater: prev => prev.map(c => (c.uuid === chat.uuid ? { ...c, lastMessage: newLast ?? undefined } : c))
				})
			}

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

			const chat = wrapChat(inner.chat)

			// Seed the messages-query cache map: this chat is introduced without a listChats, so
			// opening it before the chats list refetches would otherwise cache-miss and render
			// "No messages" (see useChatMessages.query fetchData).
			cache.chatUuidToChat.set(chat.uuid, chat)

			chatsQueryUpdate({
				updater: prev => [...(prev ?? []).filter(c => c.uuid !== chat.uuid), chat]
			})

			break
		}

		case ChatEvent_Tags.ConversationDeleted: {
			const [inner] = eventInner.inner.inner

			if (!(await removeChatLocally(inner.uuid))) {
				logger.warn("chats", "ConversationDeleted: chat not in cache", { chatUuid: inner.uuid })
			}

			break
		}

		case ChatEvent_Tags.ConversationParticipantLeft: {
			const [inner] = eventInner.inner.inner

			// The leaver is ourselves (left from another device/session): the chat is gone for
			// this account — remove it locally like a deletion. Keeping it would render a chat
			// whose participants no longer include us (send silently no-ops, leave/selection
			// gating breaks).
			if (inner.userId === userId) {
				await removeChatLocally(inner.uuid)

				break
			}

			const chats = chatsQueryGet()
			const chat = chats?.find(c => c.uuid === inner.uuid)

			if (!chat) {
				break
			}

			const updatedChat = {
				...chat,
				participants: chat.participants.filter(p => p.userId !== inner.userId)
			}

			// Keep the messages-query cache map coherent with the chats query (mirrors
			// ConversationParticipantNew below).
			cache.chatUuidToChat.set(updatedChat.uuid, updatedChat)

			chatsQueryUpdate({
				updater: prev => prev.map(c => (c.uuid === inner.uuid ? updatedChat : c))
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

			const updatedChat = {
				...chat,
				participants: [...chat.participants.filter(p => p.userId !== inner.participant.userId), inner.participant]
			}

			// Keep the messages-query cache map coherent with the chats query so a chat that was
			// only ever introduced via socket (never via listChats) still resolves on open.
			cache.chatUuidToChat.set(updatedChat.uuid, updatedChat)

			chatsQueryUpdate({
				updater: prev => prev.map(c => (c.uuid === inner.chat ? updatedChat : c))
			})

			break
		}

		default: {
			logger.error("chats", "Unhandled chat event", { tag: (eventInner.inner as { tag: string }).tag })

			throw new Error("Unhandled chat event")
		}
	}
}
