import auth from "@/lib/auth"
import { ensureDotFilenSubdirectory } from "@/lib/dotFilenDirectory"
import { type ChatMessagePartial, type ChatTypingType, type Contact, type ChatParticipant, AnyNormalDir } from "@filen/sdk-rs"
import { type Chat, type ChatMessage } from "@/types"
import { chatsQueryUpdate, chatsQueryFetch, chatsQueryGet, replaceChatInCache } from "@/features/chats/queries/useChats.query"
import {
	chatMessagesQueryUpdate,
	chatMessagesQueryFetch,
	chatMessagesQueryGet,
	chatMessagesQueryIsActive
} from "@/features/chats/queries/useChatMessages.query"
import { cachedMessagesMatchLastMessage } from "@/features/chats/chatSelectors"
import { wrapChat, wrapMessage, withoutInflight } from "@/features/chats/chatsWrap"
import { Semaphore, run, runOrThrow } from "@filen/shared"
import transfers from "@/features/transfers/transfers"
import drive from "@/features/drive/drive"
import { unwrapFileMeta, unwrappedFileIntoDriveItem, makeDriveItemPublicLink } from "@/lib/sdkUnwrap"
import * as FileSystem from "expo-file-system"
import { purgeChatInflightState } from "@/features/chats/chatsInflight"
import useChatsStore, { applyChatMessagePatch, type ChatMessagePatch } from "@/features/chats/store/useChats.store"
import logger from "@/lib/logger"
import { uploadQuotaRefusal } from "@/features/transfers/quota"
import { toSignalOpts } from "@/lib/signals"

// Deferred so the chat _layout redirect doesn't fire while the removed chat is still on screen,
// which janks the navigation stack.
const CHAT_CACHE_REMOVAL_DELAY_MS = 3000

export function dropChatFromCachesDeferred(uuid: string): void {
	setTimeout(() => {
		chatsQueryUpdate({
			updater: prev => prev.filter(c => c.uuid !== uuid)
		})

		chatMessagesQueryUpdate({
			params: {
				uuid
			},
			updater: () => []
		})
	}, CHAT_CACHE_REMOVAL_DELAY_MS)
}

// Older paginated pages live outside the query, so every per-message patch has to reach both.
export function patchChatMessage({ chatUuid, messageUuid, patch }: { chatUuid: string; messageUuid: string; patch: ChatMessagePatch }): void {
	chatMessagesQueryUpdate({
		params: {
			uuid: chatUuid
		},
		updater: prev => applyChatMessagePatch(prev, messageUuid, patch)
	})

	useChatsStore.getState().patchOlderMessage(messageUuid, patch)
}

class Chats {
	private readonly refetchChatsAndMessagesMutex: Semaphore = new Semaphore(1)

	public async listBefore({ chat, before, signal }: { chat: Chat; before: bigint; signal?: AbortSignal }): Promise<ChatMessage[]> {
		const { authedSdkClient } = await auth.getSdkClients()

		const messages = await authedSdkClient.listMessagesBefore(
			chat,
			before,
			toSignalOpts(signal)
		)

		return messages.map(wrapMessage)
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

		// sendChatMessage is the single commit boundary: once it resolves the message is
		// irreversibly accepted server-side and carried back on the returned chat's lastMessage.
		// Everything after this point must be best-effort and never re-throw, otherwise the
		// inflight retry path (sync.tsx) would re-send the already-committed message and create
		// a peer-visible duplicate (no client-supplied id means each retry is a brand-new message).
		chat = wrapChat(
			await authedSdkClient.sendChatMessage(
				chat,
				message,
				replyTo,
				toSignalOpts(signal)
			)
		)

		// The committed message is carried back on the returned chat's lastMessage.
		const sdkLastMessage = chat.lastMessage
		const lastMessage = sdkLastMessage ? wrapMessage(sdkLastMessage) : null

		// Reconcile the query cache immediately off the committed chat: drop the optimistic
		// in-flight copy (matched by inflightId) and any prior copy of the same server uuid,
		// then append the committed message.
		replaceChatInCache(chat)

		if (lastMessage) {
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
		} else {
			// No committed message on the returned chat (unexpected SDK state) — still drop the
			// optimistic in-flight copy so the inflight queue can be cleared and the send is not retried.
			logger.error("chats", "sendMessage: no lastMessage on committed chat", { chatUuid: chat.uuid, inflightId })

			chatMessagesQueryUpdate({
				params: {
					uuid: chat.uuid
				},
				updater: prev => prev.filter(m => m.inflightId !== inflightId)
			})
		}

		// Post-commit housekeeping is best-effort — a rejection here must NOT bubble, or the
		// committed message would be retried and duplicated.
		await this.markAsRead({
			chat,
			signal
		}).catch(() => {})

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
			toSignalOpts(signal)
		)
	}

	public async deleteMessage({ chat, message, signal }: { chat: Chat; message: ChatMessage; signal?: AbortSignal }) {
		const { authedSdkClient } = await auth.getSdkClients()

		chat = wrapChat(
			await authedSdkClient.deleteMessage(
				chat,
				message,
				toSignalOpts(signal)
			)
		)

		replaceChatInCache(chat)

		patchChatMessage({
			chatUuid: chat.uuid,
			messageUuid: message.inner.uuid,
			patch: "delete"
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

		message = wrapMessage(
			await authedSdkClient.editMessage(
				chat,
				message,
				newMessage,
				toSignalOpts(signal)
			)
		)

		chatsQueryUpdate({
			updater: prev =>
				prev.map(c =>
					c.uuid === chat.uuid
						? {
								...c,
								lastMessage: c.lastMessage?.inner.uuid === message.inner.uuid ? message : c.lastMessage
							}
						: c
				)
		})

		const edited = withoutInflight(message)

		patchChatMessage({
			chatUuid: chat.uuid,
			messageUuid: message.inner.uuid,
			patch: () => edited
		})

		return message
	}

	public async disableMessageEmbed({ message, signal }: { message: ChatMessage; signal?: AbortSignal }) {
		if (message.embedDisabled) {
			return message
		}

		const { authedSdkClient } = await auth.getSdkClients()

		message = wrapMessage(
			await authedSdkClient.disableMessageEmbed(
				message,
				toSignalOpts(signal)
			)
		)

		const disabled = withoutInflight(message)

		patchChatMessage({
			chatUuid: message.chat,
			messageUuid: message.inner.uuid,
			patch: () => disabled
		})

		return message
	}

	public async rename({ chat, newName, signal }: { chat: Chat; newName: string; signal?: AbortSignal }) {
		if (chat.name === newName || newName.trim().length === 0) {
			return chat
		}

		const { authedSdkClient } = await auth.getSdkClients()

		chat = wrapChat(
			await authedSdkClient.renameChat(
				chat,
				newName,
				toSignalOpts(signal)
			)
		)

		replaceChatInCache(chat)

		return chat
	}

	public async leave({ chat, signal }: { chat: Chat; signal?: AbortSignal }) {
		const { authedSdkClient } = await auth.getSdkClients()

		await authedSdkClient.leaveChat(
			chat,
			toSignalOpts(signal)
		)

		// Purge the chat's queued unsent messages, send errors and input drafts immediately —
		// the sync must never retry into a chat we just left. Best-effort (never throws).
		await purgeChatInflightState(chat.uuid)

		dropChatFromCachesDeferred(chat.uuid)
	}

	public async delete({ chat, signal }: { chat: Chat; signal?: AbortSignal }) {
		const { authedSdkClient } = await auth.getSdkClients()

		await authedSdkClient.deleteChat(
			chat,
			toSignalOpts(signal)
		)

		// Purge the chat's queued unsent messages, send errors and input drafts immediately —
		// the sync must never retry into a deleted chat. Best-effort (never throws).
		await purgeChatInflightState(chat.uuid)

		dropChatFromCachesDeferred(chat.uuid)
	}

	public async mute({ chat, signal, mute }: { chat: Chat; signal?: AbortSignal; mute: boolean }) {
		if (chat.muted === mute) {
			return chat
		}

		const { authedSdkClient } = await auth.getSdkClients()

		chat = wrapChat(
			await authedSdkClient.muteChat(
				chat,
				mute,
				toSignalOpts(signal)
			)
		)

		replaceChatInCache(chat)

		return chat
	}

	public async create({ contacts, signal }: { contacts: Contact[]; signal?: AbortSignal }) {
		const { authedSdkClient } = await auth.getSdkClients()

		const chat = wrapChat(
			await authedSdkClient.createChat(
				contacts,
				toSignalOpts(signal)
			)
		)

		chatsQueryUpdate({
			updater: prev => [...prev.filter(c => c.uuid !== chat.uuid), chat]
		})

		return chat
	}

	public async addParticipants({ chat, contacts, signal }: { chat: Chat; contacts: Contact[]; signal?: AbortSignal }) {
		// Skip contacts already in the chat; if none remain, touch neither the SDK nor the cache.
		const toAdd = contacts.filter(contact => !chat.participants.find(p => p.userId === contact.userId))

		if (toAdd.length === 0) {
			return chat
		}

		const { authedSdkClient } = await auth.getSdkClients()

		// Sequential by design: each add threads the previous result so the single cache write below
		// reflects EVERY new participant. Adding them in parallel (Promise.all) had each call compute
		// "base chat + its own contact" from the same stale chat, so the last write to resolve
		// clobbered the others — only one new participant survived in the cache until a refetch.
		let updated = chat

		for (const contact of toAdd) {
			updated = wrapChat(
				await authedSdkClient.addChatParticipant(
					updated,
					contact,
					toSignalOpts(signal)
				)
			)
		}

		replaceChatInCache(updated)

		return updated
	}

	public async removeParticipant({ chat, participant, signal }: { chat: Chat; participant: ChatParticipant; signal?: AbortSignal }) {
		if (!chat.participants.find(p => p.userId === participant.userId)) {
			return chat
		}

		const { authedSdkClient } = await auth.getSdkClients()

		chat = wrapChat(
			await authedSdkClient.removeChatParticipant(
				chat,
				participant.userId,
				toSignalOpts(signal)
			)
		)

		replaceChatInCache(chat)

		return chat
	}

	public async markRead({ chat, signal }: { chat: Chat; signal?: AbortSignal }): Promise<void> {
		const { authedSdkClient } = await auth.getSdkClients()

		await authedSdkClient.markChatRead(
			chat,
			toSignalOpts(signal)
		)
	}

	// A chat only reads as read once both the server read marker and the focus time move.
	public async markAsRead({ chat, signal }: { chat: Chat; signal?: AbortSignal }): Promise<void> {
		await Promise.all([
			this.updateLastFocusTimesNow({
				chats: [chat],
				signal
			}),
			this.markRead({
				chat,
				signal
			})
		])
	}

	public async updateLastFocusTimesNow({ chats, signal }: { chats: Chat[]; signal?: AbortSignal }) {
		const { authedSdkClient } = await auth.getSdkClients()

		chats = (
			await authedSdkClient.updateLastChatFocusTimesNow(
				chats,
				toSignalOpts(signal)
			)
		).map(wrapChat)

		for (const chat of chats) {
			replaceChatInCache(chat)
		}

		return chats
	}

	// The listing is always re-read (read state, mute and lastMessage carry no socket event while
	// disconnected); a chat's message page when its lastMessage moved away from the cached one, or
	// when the chat is open: older edits/deletes in an unchanged chat otherwise wait for the chat's
	// next opening, and an open chat's screen shows them now.
	public async refetchChatsAndMessages() {
		await run(
			async defer => {
				await this.refetchChatsAndMessagesMutex.acquire()

				defer(() => {
					this.refetchChatsAndMessagesMutex.release()
				})

				const chats = await chatsQueryFetch()

				await Promise.all(
					chats
						.filter(
							chat =>
								chatMessagesQueryIsActive({
									uuid: chat.uuid
								}) ||
								!cachedMessagesMatchLastMessage(
									chat,
									chatMessagesQueryGet({
										uuid: chat.uuid
									})
								)
						)
						.map(chat =>
							// The fresh chat by value, so the read never depends on the list query's current contents.
							chatMessagesQueryFetch({
								uuid: chat.uuid,
								chat
							})
						)
				)
			},
			{
				throw: true
			}
		)
	}

	// Only the listed chats with no cached page at all — the listing itself is already current.
	public async fetchMissingMessages() {
		const chats = chatsQueryGet() ?? []

		await Promise.all(
			chats
				.filter(
					chat =>
						!chatMessagesQueryGet({
							uuid: chat.uuid
						})
				)
				.map(chat =>
					chatMessagesQueryFetch({
						uuid: chat.uuid,
						chat
					})
				)
		)
	}

	public async getChatUploadsDirectory() {
		return await ensureDotFilenSubdirectory("Chat Uploads")
	}

	// Uploads the given local assets into the chat-uploads directory, enables a public
	// link for each resulting file and returns the shareable link strings. Silent: throws
	// on failure, never surfaces UI — callers own the loading/error UX.
	public async uploadAssetsAndGenerateLinks(
		assets: {
			uri: string
			name: string
			lastModified?: number
			mimeType?: string
		}[]
	): Promise<string[]> {
		// Refused before any transfer row exists; the caller shows the message like any failed upload.
		const refusal = await uploadQuotaRefusal(
			assets.map(asset => {
				const assetFile = new FileSystem.File(asset.uri)

				return assetFile.exists ? assetFile.size : 0
			})
		)

		if (refusal) {
			for (const asset of assets) {
				const assetFile = new FileSystem.File(asset.uri)

				if (assetFile.exists) {
					assetFile.delete()
				}
			}

			throw new Error(refusal)
		}

		const parent = new AnyNormalDir.Dir(await this.getChatUploadsDirectory())

		return (
			await Promise.all(
				assets.map(async asset => {
					const uploadedLinks = await runOrThrow(async defer => {
						const assetFile = new FileSystem.File(asset.uri)

						defer(() => {
							if (assetFile.exists) {
								assetFile.delete()
							}
						})

						if (!assetFile.exists) {
							throw new Error("Asset file does not exist")
						}

						const assetNameParsed = FileSystem.Paths.parse(asset.name)
						const uploadResult = await transfers.upload({
							localFileOrDir: assetFile,
							parent,
							name: `${assetNameParsed.name}.${Date.now()}${assetNameParsed.ext}`,
							modified: asset.lastModified,
							mime: asset.mimeType
						})

						if (!uploadResult) {
							logger.warn("chats", "asset upload returned no result", { assetName: asset.name, assetUri: asset.uri })

							return []
						}

						const items = uploadResult.files.map(f => unwrappedFileIntoDriveItem(unwrapFileMeta(f)))

						const links = (
							await Promise.all(
								items.map(async item => {
									// The uuid was minted by this upload, so no link can exist yet.
									const link = await drive.enablePublicLink({
										item,
										knownAbsent: true
									})

									if (link.type !== "file") {
										logger.warn("chats", "public link for uploaded asset is not file type", { linkType: link.type, assetName: asset.name })

										return null
									}

									return {
										link: link.link,
										item
									}
								})
							)
						).filter((l): l is NonNullable<typeof l> => l !== null)

						return links
					})

					const links = uploadedLinks
						.map(link => {
							return makeDriveItemPublicLink({
								item: link.item,
								linkUuid: link.link.linkUuid
							})
						})
						.filter((l): l is NonNullable<typeof l> => l !== null)

					if (links.length === 0) {
						return []
					}

					return links
				})
			)
		).flat()
	}
}

const chats = new Chats()

export default chats
