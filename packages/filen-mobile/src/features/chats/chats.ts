import auth from "@/lib/auth"
import {
	type ChatMessagePartial,
	ChatTypingType,
	type Contact,
	type ChatParticipant,
	type Chat as SdkChat,
	type ChatMessage as SdkChatMessage,
	AnyNormalDir,
	DirMeta_Tags
} from "@filen/sdk-rs"
import { type Chat, type ChatMessage } from "@/types"
import { chatsQueryUpdate, fetchData as chatsQueryFetch } from "@/features/chats/queries/useChats.query"
import { chatMessagesQueryUpdate, fetchData as chatMessagesQueryFetch } from "@/features/chats/queries/useChatMessages.query"
import { Semaphore, run } from "@filen/utils"
import transfers from "@/features/transfers/transfers"
import drive from "@/features/drive/drive"
import { unwrapFileMeta, unwrappedFileIntoDriveItem, makeDriveItemPublicLink } from "@/lib/utils"
import * as FileSystem from "expo-file-system"

function wrapChat(chat: SdkChat): Chat {
	return {
		...chat,
		undecryptable: chat.key === undefined
	}
}

function wrapMessage(message: SdkChatMessage): ChatMessage {
	return {
		...message,
		undecryptable: message.inner.message === undefined
	}
}

class Chats {
	private readonly refetchChatsAndMessagesMutex: Semaphore = new Semaphore(1)

	public async listBefore({ chat, before, signal }: { chat: Chat; before: bigint; signal?: AbortSignal }): Promise<ChatMessage[]> {
		const { authedSdkClient } = await auth.getSdkClients()

		const messages = await authedSdkClient.listMessagesBefore(
			chat,
			before,
			signal
				? {
						signal
					}
				: undefined
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

		this.sendTyping({
			chat,
			type: ChatTypingType.Up,
			signal
		}).catch(() => {})

		chat = wrapChat(
			await authedSdkClient.sendChatMessage(
				chat,
				message,
				replyTo,
				signal
					? {
							signal
						}
					: undefined
			)
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

		const sdkLastMessage = chat.lastMessage

		if (!sdkLastMessage) {
			throw new Error("No last message after sending message")
		}

		const lastMessage = wrapMessage(sdkLastMessage)

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

		chat = wrapChat(
			await authedSdkClient.deleteMessage(
				chat,
				message,
				signal
					? {
							signal
						}
					: undefined
			)
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

		message = wrapMessage(
			await authedSdkClient.editMessage(
				chat,
				message,
				newMessage,
				signal
					? {
							signal
						}
					: undefined
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

		message = wrapMessage(
			await authedSdkClient.disableMessageEmbed(
				message,
				signal
					? {
							signal
						}
					: undefined
			)
		)

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

		chat = wrapChat(
			await authedSdkClient.renameChat(
				chat,
				newName,
				signal
					? {
							signal
						}
					: undefined
			)
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

		chat = wrapChat(
			await authedSdkClient.muteChat(
				chat,
				mute,
				signal
					? {
							signal
						}
					: undefined
			)
		)

		chatsQueryUpdate({
			updater: prev => prev.map(c => (c.uuid === chat.uuid ? chat : c))
		})

		return chat
	}

	public async create({ contacts, signal }: { contacts: Contact[]; signal?: AbortSignal }) {
		const { authedSdkClient } = await auth.getSdkClients()

		const chat = wrapChat(
			await authedSdkClient.createChat(
				contacts,
				signal
					? {
							signal
						}
					: undefined
			)
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

		chat = wrapChat(
			await authedSdkClient.addChatParticipant(
				chat,
				contact,
				signal
					? {
							signal
						}
					: undefined
			)
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

		chat = wrapChat(
			await authedSdkClient.removeChatParticipant(
				chat,
				participant.userId,
				signal
					? {
							signal
						}
					: undefined
			)
		)

		chatsQueryUpdate({
			updater: prev => prev.map(c => (c.uuid === chat.uuid ? chat : c))
		})

		return chat
	}

	public async markRead({ chat, signal }: { chat: Chat; signal?: AbortSignal }): Promise<void> {
		const { authedSdkClient } = await auth.getSdkClients()

		await authedSdkClient.markChatRead(
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

		chat = wrapChat(
			await authedSdkClient.updateChatOnlineStatus(
				chat,
				signal
					? {
							signal
						}
					: undefined
			)
		)

		chatsQueryUpdate({
			updater: prev => prev.map(c => (c.uuid === chat.uuid ? chat : c))
		})

		return chat
	}

	public async updateLastFocusTimesNow({ chats, signal }: { chats: Chat[]; signal?: AbortSignal }) {
		const { authedSdkClient } = await auth.getSdkClients()

		chats = (
			await authedSdkClient.updateLastChatFocusTimesNow(
				chats,
				signal
					? {
							signal
						}
					: undefined
			)
		).map(wrapChat)

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

	public async getChatUploadsDirectory() {
		const { authedSdkClient } = await auth.getSdkClients()

		let dotFilenDir = (
			await authedSdkClient.listDir(
				new AnyNormalDir.Root({
					uuid: authedSdkClient.root().uuid
				})
			)
		).dirs.find(d => d.meta.tag === DirMeta_Tags.Decoded && d.meta.inner[0].name.trim().toLowerCase() === ".filen")

		if (!dotFilenDir) {
			dotFilenDir = await authedSdkClient.createDir(
				new AnyNormalDir.Root({
					uuid: authedSdkClient.root().uuid
				}),
				".filen"
			)
		}

		let chatUploadsDir = (await authedSdkClient.listDir(new AnyNormalDir.Dir(dotFilenDir))).dirs.find(
			d => d.meta.tag === DirMeta_Tags.Decoded && d.meta.inner[0].name.trim().toLowerCase() === "chat uploads"
		)

		if (!chatUploadsDir) {
			chatUploadsDir = await authedSdkClient.createDir(new AnyNormalDir.Dir(dotFilenDir), "Chat Uploads")
		}

		return chatUploadsDir
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
		const parent = new AnyNormalDir.Dir(await this.getChatUploadsDirectory())

		return (
			await Promise.all(
				assets.map(async asset => {
					const result = await run(async defer => {
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
							return []
						}

						const items = uploadResult.files.map(f => unwrappedFileIntoDriveItem(unwrapFileMeta(f)))

						const links = (
							await Promise.all(
								items.map(async item => {
									const link = await drive.enablePublicLink({
										item
									})

									if (link.type !== "file") {
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

					if (!result.success) {
						throw result.error
					}

					const links = result.data
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
