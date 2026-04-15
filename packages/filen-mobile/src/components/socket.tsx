import { useSdkClients, useStringifiedClient } from "@/lib/auth"
import {
	type JsClientInterface,
	SocketEvent_Tags,
	ChatTypingType,
	ListenerHandle,
	ChatEvent_Tags,
	NoteEvent_Tags,
	GeneralEvent_Tags,
	DriveEvent_Tags,
	ContactEvent_Tags,
	MaybeEncryptedUniffi_Tags,
	type SocketEvent,
	NonRootItem_Tags,
	AnyNormalDir_Tags
} from "@filen/sdk-rs"
import { useEffect, useRef, memo, useCallback } from "react"
import { runEffect, run, Semaphore } from "@filen/utils"
import useChatsStore from "@/stores/useChats.store"
import { chatMessagesQueryUpdate, chatMessagesQueryGet } from "@/queries/useChatMessages.query"
import { chatsQueryGet, chatsQueryUpdate } from "@/queries/useChats.query"
import events from "@/lib/events"
import useSocketStore from "@/stores/useSocket.store"
import alerts from "@/lib/alerts"
import { AppState, type AppStateStatus } from "react-native"
import useEffectOnce from "@/hooks/useEffectOnce"
import chats from "@/lib/chats"
import {
	notesWithContentQueryUpdate,
	fetchData as notesWithContentQueryFetch,
	notesWithContentQueryGet
} from "@/queries/useNotesWithContent.query"
import { contactRequestsQueryUpdate } from "@/queries/useContactRequests.query"
import { driveItemsQueryUpdateGlobal, driveItemsQueryUpdate } from "@/queries/useDriveItems.query"
import { unwrapParentUuid, unwrapFileMeta, unwrappedFileIntoDriveItem, unwrapDirMeta, unwrappedDirIntoDriveItem } from "@/lib/utils"
import cache from "@/lib/cache"

const chatTypingTimeoutsRef: Record<number, NodeJS.Timeout> = {}

async function onEvent({ event, userId }: { event: SocketEvent; userId: bigint }) {
	try {
		switch (event.tag) {
			case SocketEvent_Tags.Reconnecting:
			case SocketEvent_Tags.AuthSuccess:
			case SocketEvent_Tags.AuthFailed:
			case SocketEvent_Tags.Unsubscribed: {
				for (const timeout of Object.values(chatTypingTimeoutsRef)) {
					clearTimeout(timeout)
				}

				useChatsStore.getState().setTyping({})

				useSocketStore
					.getState()
					.setState(
						event.tag === SocketEvent_Tags.Reconnecting
							? "reconnecting"
							: event.tag === SocketEvent_Tags.AuthSuccess
								? "connected"
								: "disconnected"
					)

				if (event.tag === SocketEvent_Tags.AuthSuccess) {
					// Refetch chats and messages to ensure we have the latest data after reconnect + to update unread counts
					chats.refetchChatsAndMessages().catch(console.error)
				}

				break
			}

			case SocketEvent_Tags.General: {
				const [eventInner] = event.inner

				switch (eventInner.inner.tag) {
					case GeneralEvent_Tags.PasswordChanged: {
						// TODO: Logout

						break
					}

					case GeneralEvent_Tags.NewEvent: {
						// Noop

						break
					}

					default: {
						console.error(eventInner)

						throw new Error("Unhandled general event")
					}
				}

				break
			}

			case SocketEvent_Tags.Drive: {
				const [eventInner] = event.inner

				switch (eventInner.inner.tag) {
					case DriveEvent_Tags.FileArchiveRestored:
					case DriveEvent_Tags.FileRestore:
					case DriveEvent_Tags.FileNew: {
						const [inner] = eventInner.inner.inner

						const unwrappedParentUuid = unwrapParentUuid(inner.file.parent)
						const unwrappedFileMeta = unwrapFileMeta(inner.file)

						if (unwrappedParentUuid) {
							driveItemsQueryUpdate({
								params: {
									path: {
										type: "drive",
										uuid: unwrappedParentUuid
									}
								},
								updater: prev => [
									...prev.filter(
										i =>
											i.data.uuid !== unwrappedFileMeta.file.uuid &&
											i.data.decryptedMeta?.name.toLowerCase().trim() !==
												unwrappedFileMeta.meta?.name.toLowerCase().trim()
									),
									unwrappedFileIntoDriveItem(unwrappedFileMeta)
								]
							})
						}

						if (eventInner.inner.tag === DriveEvent_Tags.FileRestore) {
							// In case of a restore from trash, we need to remove the item from the trash list
							driveItemsQueryUpdate({
								params: {
									path: {
										type: "trash",
										uuid: null
									}
								},
								updater: prev => prev.filter(i => i.data.uuid !== unwrappedFileMeta.file.uuid)
							})
						}

						break
					}

					case DriveEvent_Tags.FileArchived:
					case DriveEvent_Tags.FileDeletedPermanent:
					case DriveEvent_Tags.FolderDeletedPermanent: {
						const [inner] = eventInner.inner.inner

						const fromCache = cache.fileUuidToNormalFile.get(inner.uuid)

						if (fromCache) {
							const unwrappedParentUuid = unwrapParentUuid(fromCache.parent)

							if (unwrappedParentUuid) {
								driveItemsQueryUpdateGlobal({
									parentUuid: unwrappedParentUuid,
									updater: prev => prev.filter(i => i.data.uuid !== fromCache.uuid)
								})
							}
						}

						break
					}

					case DriveEvent_Tags.FileMetadataChanged: {
						const [inner] = eventInner.inner.inner

						const fromCache = cache.fileUuidToNormalFile.get(inner.uuid)

						if (fromCache) {
							const unwrappedParentUuid = unwrapParentUuid(fromCache.parent)
							const unwrappedFileMeta = unwrapFileMeta({
								...fromCache,
								meta: inner.metadata
							})

							if (unwrappedParentUuid) {
								driveItemsQueryUpdateGlobal({
									parentUuid: unwrappedParentUuid,
									updater: prev =>
										prev.map(i =>
											i.data.uuid === unwrappedFileMeta.file.uuid ? unwrappedFileIntoDriveItem(unwrappedFileMeta) : i
										)
								})
							}
						}

						break
					}

					case DriveEvent_Tags.FileMove: {
						const [inner] = eventInner.inner.inner

						const fromCacheOld = cache.fileUuidToNormalFile.get(inner.file.uuid)

						if (fromCacheOld) {
							const unwrappedParentUuidOld = unwrapParentUuid(fromCacheOld.parent)
							const unwrappedParentUuidNew = unwrapParentUuid(inner.file.parent)
							const unwrappedFileMeta = unwrapFileMeta(inner.file)

							if (unwrappedParentUuidNew && unwrappedParentUuidOld) {
								driveItemsQueryUpdate({
									params: {
										path: {
											type: "drive",
											uuid: unwrappedParentUuidOld
										}
									},
									updater: prev => prev.filter(i => i.data.uuid !== fromCacheOld.uuid)
								})

								driveItemsQueryUpdate({
									params: {
										path: {
											type: "drive",
											uuid: unwrappedParentUuidNew
										}
									},
									updater: prev => [
										...prev.filter(
											i =>
												i.data.uuid !== unwrappedFileMeta.file.uuid &&
												i.data.decryptedMeta?.name.toLowerCase().trim() !==
													unwrappedFileMeta.meta?.name.toLowerCase().trim()
										),
										unwrappedFileIntoDriveItem(unwrappedFileMeta)
									]
								})
							}
						}

						break
					}

					case DriveEvent_Tags.FolderMove: {
						const [inner] = eventInner.inner.inner

						const fromCacheOld = cache.directoryUuidToAnyNormalDir.get(inner.dir.uuid)

						if (fromCacheOld && fromCacheOld.tag === AnyNormalDir_Tags.Dir) {
							const unwrappedParentUuidOld = unwrapParentUuid(fromCacheOld.inner[0].parent)
							const unwrappedParentUuidNew = unwrapParentUuid(inner.dir.parent)
							const unwrappedDirMeta = unwrapDirMeta(inner.dir)

							if (unwrappedParentUuidNew && unwrappedParentUuidOld) {
								driveItemsQueryUpdate({
									params: {
										path: {
											type: "drive",
											uuid: unwrappedParentUuidOld
										}
									},
									updater: prev => prev.filter(i => i.data.uuid !== fromCacheOld.inner[0].uuid)
								})

								driveItemsQueryUpdate({
									params: {
										path: {
											type: "drive",
											uuid: unwrappedParentUuidNew
										}
									},
									updater: prev => [
										...prev.filter(
											i =>
												i.data.uuid !== unwrappedDirMeta.uuid &&
												i.data.decryptedMeta?.name.toLowerCase().trim() !==
													unwrappedDirMeta.meta?.name.toLowerCase().trim()
										),
										unwrappedDirIntoDriveItem(unwrappedDirMeta)
									]
								})
							}
						}

						break
					}

					case DriveEvent_Tags.FolderMetadataChanged: {
						const [inner] = eventInner.inner.inner

						const fromCache = cache.directoryUuidToAnyNormalDir.get(inner.uuid)

						if (fromCache && fromCache.tag === AnyNormalDir_Tags.Dir) {
							const unwrappedParentUuid = unwrapParentUuid(fromCache.inner[0].parent)
							const unwrappedDirMeta = unwrapDirMeta({
								...fromCache.inner[0],
								meta: inner.meta
							})

							if (unwrappedParentUuid) {
								driveItemsQueryUpdateGlobal({
									parentUuid: unwrappedParentUuid,
									updater: prev =>
										prev.map(i =>
											i.data.uuid === unwrappedDirMeta.uuid ? unwrappedDirIntoDriveItem(unwrappedDirMeta) : i
										)
								})
							}
						}

						break
					}

					case DriveEvent_Tags.FileTrash: {
						const [inner] = eventInner.inner.inner

						const fromCache = cache.fileUuidToNormalFile.get(inner.uuid)

						if (fromCache) {
							const unwrappedParentUuid = unwrapParentUuid(fromCache.parent)

							if (unwrappedParentUuid) {
								driveItemsQueryUpdateGlobal({
									parentUuid: unwrappedParentUuid,
									updater: prev => prev.filter(i => i.data.uuid !== fromCache.uuid)
								})
							}

							const item = unwrappedFileIntoDriveItem(unwrapFileMeta(fromCache))

							// We have to add it to recents again after removing it above in the global call
							driveItemsQueryUpdate({
								params: {
									path: {
										type: "recents",
										uuid: null
									}
								},
								updater: prev => [...prev.filter(i => i.data.uuid !== fromCache.uuid), item]
							})

							driveItemsQueryUpdate({
								params: {
									path: {
										type: "trash",
										uuid: null
									}
								},
								updater: prev => [...prev.filter(i => i.data.uuid !== fromCache.uuid), item]
							})
						}

						break
					}

					case DriveEvent_Tags.FolderTrash: {
						const [inner] = eventInner.inner.inner

						const fromCache = cache.directoryUuidToAnyNormalDir.get(inner.uuid)

						if (fromCache && fromCache.tag === AnyNormalDir_Tags.Dir) {
							const unwrappedParentUuid = unwrapParentUuid(fromCache.inner[0].parent)

							if (unwrappedParentUuid) {
								driveItemsQueryUpdateGlobal({
									parentUuid: unwrappedParentUuid,
									updater: prev => prev.filter(i => i.data.uuid !== fromCache.inner[0].uuid)
								})
							}

							const item = unwrappedDirIntoDriveItem(unwrapDirMeta(fromCache.inner[0]))

							// We have to add it to recents again after removing it above in the global call
							driveItemsQueryUpdate({
								params: {
									path: {
										type: "recents",
										uuid: null
									}
								},
								updater: prev => [...prev.filter(i => i.data.uuid !== fromCache.inner[0].uuid), item]
							})

							driveItemsQueryUpdate({
								params: {
									path: {
										type: "trash",
										uuid: null
									}
								},
								updater: prev => [...prev.filter(i => i.data.uuid !== fromCache.inner[0].uuid), item]
							})
						}

						break
					}

					case DriveEvent_Tags.FolderColorChanged: {
						const [inner] = eventInner.inner.inner

						const fromCache = cache.directoryUuidToAnyNormalDir.get(inner.uuid)

						if (fromCache && fromCache.tag === AnyNormalDir_Tags.Dir) {
							const unwrappedParentUuid = unwrapParentUuid(fromCache.inner[0].parent)

							if (unwrappedParentUuid) {
								driveItemsQueryUpdateGlobal({
									parentUuid: unwrappedParentUuid,
									updater: prev =>
										prev.map(i =>
											i.data.uuid === fromCache.inner[0].uuid && i.type === "directory"
												? {
														...i,
														data: {
															...i.data,
															color: inner.color
														}
													}
												: i
										)
								})
							}
						}

						break
					}

					case DriveEvent_Tags.FolderRestore:
					case DriveEvent_Tags.FolderSubCreated: {
						const [inner] = eventInner.inner.inner

						const unwrappedParentUuid = unwrapParentUuid(inner.dir.parent)
						const unwrappedDirMeta = unwrapDirMeta(inner.dir)

						if (unwrappedParentUuid) {
							driveItemsQueryUpdate({
								params: {
									path: {
										type: "drive",
										uuid: unwrappedParentUuid
									}
								},
								updater: prev => [
									...prev.filter(
										i =>
											i.data.uuid !== unwrappedDirMeta.uuid &&
											i.data.decryptedMeta?.name.toLowerCase().trim() !==
												unwrappedDirMeta.meta?.name.toLowerCase().trim()
									),
									unwrappedDirIntoDriveItem(unwrappedDirMeta)
								]
							})
						}

						if (eventInner.inner.tag === DriveEvent_Tags.FolderRestore) {
							// In case of a restore from trash, we need to remove the item from the trash list
							driveItemsQueryUpdate({
								params: {
									path: {
										type: "trash",
										uuid: null
									}
								},
								updater: prev => prev.filter(i => i.data.uuid !== unwrappedDirMeta.uuid)
							})
						}

						break
					}

					case DriveEvent_Tags.ItemFavorite: {
						const [inner] = eventInner.inner.inner

						switch (inner.item.tag) {
							case NonRootItem_Tags.File: {
								const fromCache = cache.fileUuidToNormalFile.get(inner.item.inner[0].uuid)

								if (fromCache) {
									const unwrappedParentUuid = unwrapParentUuid(fromCache.parent)
									const unwrappedFileMeta = unwrapFileMeta(inner.item.inner[0])

									if (unwrappedParentUuid) {
										driveItemsQueryUpdateGlobal({
											parentUuid: unwrappedParentUuid,
											updater: prev =>
												prev.map(i =>
													i.data.uuid === unwrappedFileMeta.file.uuid
														? unwrappedFileIntoDriveItem(unwrappedFileMeta)
														: i
												)
										})
									}
								}

								break
							}

							case NonRootItem_Tags.NormalDir: {
								const fromCache = cache.directoryUuidToAnyNormalDir.get(inner.item.inner[0].uuid)

								if (fromCache && fromCache.tag === AnyNormalDir_Tags.Dir) {
									const unwrappedParentUuid = unwrapParentUuid(fromCache.inner[0].parent)
									const unwrappedDirMeta = unwrapDirMeta(inner.item.inner[0])

									if (unwrappedParentUuid) {
										driveItemsQueryUpdateGlobal({
											parentUuid: unwrappedParentUuid,
											updater: prev =>
												prev.map(i =>
													i.data.uuid === unwrappedDirMeta.uuid ? unwrappedDirIntoDriveItem(unwrappedDirMeta) : i
												)
										})
									}
								}

								break
							}
						}

						break
					}

					case DriveEvent_Tags.TrashEmpty: {
						driveItemsQueryUpdate({
							params: {
								path: {
									type: "trash",
									uuid: null
								}
							},
							updater: () => []
						})

						break
					}

					default: {
						console.error(eventInner)

						throw new Error("Unhandled drive event")
					}
				}

				break
			}

			case SocketEvent_Tags.Chat: {
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
							updater: prev => [...(prev ?? []).filter(c => c.uuid !== inner.chat.uuid), inner.chat]
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
												participants: [
													...c.participants.filter(p => p.userId !== inner.participant.userId),
													inner.participant
												]
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

				break
			}

			case SocketEvent_Tags.Note: {
				const [eventInner] = event.inner

				switch (eventInner.inner.tag) {
					case NoteEvent_Tags.Archived: {
						const [inner] = eventInner.inner.inner

						notesWithContentQueryUpdate({
							updater: prev =>
								prev.map(n =>
									n.uuid === inner.note
										? {
												...n,
												archived: true
											}
										: n
								)
						})

						break
					}

					case NoteEvent_Tags.Deleted: {
						const [inner] = eventInner.inner.inner

						notesWithContentQueryUpdate({
							updater: prev => prev.filter(n => n.uuid !== inner.note)
						})

						break
					}

					case NoteEvent_Tags.Restored: {
						const [inner] = eventInner.inner.inner

						notesWithContentQueryUpdate({
							updater: prev =>
								prev.map(n =>
									n.uuid === inner.note
										? {
												...n,
												archived: false,
												trashed: false
											}
										: n
								)
						})

						break
					}

					case NoteEvent_Tags.TitleEdited: {
						const [inner] = eventInner.inner.inner

						switch (inner.newTitle.tag) {
							case MaybeEncryptedUniffi_Tags.Decrypted: {
								const [newTitle] = inner.newTitle.inner

								notesWithContentQueryUpdate({
									updater: prev =>
										prev.map(n =>
											n.uuid === inner.note
												? {
														...n,
														title: newTitle
													}
												: n
										)
								})
							}
						}

						break
					}

					case NoteEvent_Tags.ParticipantNew: {
						const [inner] = eventInner.inner.inner

						notesWithContentQueryUpdate({
							updater: prev =>
								prev.map(n =>
									n.uuid === inner.note
										? {
												...n,
												participants: [
													...n.participants.filter(p => p.userId !== inner.participant.userId),
													inner.participant
												]
											}
										: n
								)
						})

						break
					}

					case NoteEvent_Tags.ParticipantRemoved: {
						const [inner] = eventInner.inner.inner

						notesWithContentQueryUpdate({
							updater: prev =>
								prev.map(n =>
									n.uuid === inner.note
										? {
												...n,
												participants: n.participants.filter(p => p.userId !== inner.userId)
											}
										: n
								)
						})

						break
					}

					case NoteEvent_Tags.ParticipantPermissions: {
						const [inner] = eventInner.inner.inner

						notesWithContentQueryUpdate({
							updater: prev =>
								prev.map(n =>
									n.uuid === inner.note
										? {
												...n,
												participants: n.participants.map(p =>
													p.userId === inner.userId
														? {
																...p,
																permissionsWrite: inner.permissionsWrite
															}
														: p
												)
											}
										: n
								)
						})

						break
					}

					case NoteEvent_Tags.New: {
						// TODO: Don't refetch the query, build from socket event once added
						const notesWithContent = await notesWithContentQueryFetch()

						notesWithContentQueryUpdate({
							updater: () => notesWithContent
						})

						break
					}

					case NoteEvent_Tags.ContentEdited: {
						const [inner] = eventInner.inner.inner

						const notes = notesWithContentQueryGet()
						const note = notes?.find(n => n.uuid === inner.note)

						if (!note) {
							break
						}

						events.emit("noteContentEdited", {
							noteUuid: inner.note,
							contentEdited: inner
						})

						break
					}

					default: {
						console.error(eventInner)

						throw new Error("Unhandled note event")
					}
				}

				break
			}

			case SocketEvent_Tags.Contact: {
				const [eventInner] = event.inner

				switch (eventInner.inner.tag) {
					case ContactEvent_Tags.ContactRequestReceived: {
						const [inner] = eventInner.inner.inner

						contactRequestsQueryUpdate({
							updater: prev => ({
								...prev,
								incoming: [
									...prev.incoming.filter(r => r.uuid !== inner.uuid),
									{
										uuid: inner.uuid,
										userId: inner.senderId,
										email: inner.senderEmail,
										avatar: inner.senderAvatar,
										nickName: inner.senderNickName
									}
								]
							})
						})

						break
					}

					default: {
						console.error(eventInner)

						throw new Error("Unhandled contact event")
					}
				}

				break
			}

			default: {
				console.error(event)

				throw new Error("Unhandled event")
			}
		}
	} catch (e) {
		console.error(e)
		alerts.error(e)
	}
}

const mutex = new Semaphore(1)

const InnerSocket = memo(({ sdkClient }: { sdkClient: JsClientInterface }) => {
	const checkConnectionIntervalRef = useRef<ReturnType<typeof setInterval>>(undefined)
	const socketListenerHandleRef = useRef<ListenerHandle | null>(null)
	const stringifiedClient = useStringifiedClient()

	const onAppStateChange = useCallback(
		async (nextAppState: AppStateStatus) => {
			if (nextAppState !== "active" && nextAppState !== "background") {
				return
			}

			const result = await run(async defer => {
				await mutex.acquire()

				defer(() => {
					mutex.release()
				})

				switch (nextAppState) {
					case "active": {
						if (sdkClient.isSocketConnected()) {
							useSocketStore.getState().setState("connected")

							return
						}

						if (!socketListenerHandleRef.current) {
							socketListenerHandleRef.current = (await sdkClient.addEventListener(
								{
									onEvent: event => {
										onEvent({
											event,
											userId: stringifiedClient ? stringifiedClient.userId : BigInt(0)
										}).catch(console.error)
									}
								},
								undefined
							)) as ListenerHandle

							clearInterval(checkConnectionIntervalRef.current)

							checkConnectionIntervalRef.current = setInterval(() => {
								useSocketStore.getState().setState(prev => (sdkClient.isSocketConnected() ? "connected" : prev))
							}, 5000)
						}

						break
					}

					case "background": {
						if (socketListenerHandleRef.current) {
							socketListenerHandleRef.current.uniffiDestroy()

							socketListenerHandleRef.current = null

							useSocketStore.getState().setState("disconnected")

							clearInterval(checkConnectionIntervalRef.current)
						}

						break
					}
				}
			})

			if (!result.success) {
				console.error(result.error)
				alerts.error(result.error)

				return
			}
		},
		[sdkClient, stringifiedClient]
	)

	useEffect(() => {
		const { cleanup } = runEffect(defer => {
			const appStateSubscription = AppState.addEventListener("change", onAppStateChange)

			defer(() => {
				appStateSubscription.remove()
			})

			defer(() => {
				clearInterval(checkConnectionIntervalRef.current)
			})
		})

		return () => {
			cleanup()
		}
	}, [onAppStateChange])

	useEffectOnce(() => {
		onAppStateChange("active").catch(console.error)
	})

	return null
})

const Socket = memo(() => {
	const { authedSdkClient } = useSdkClients()

	if (!authedSdkClient) {
		return null
	}

	return <InnerSocket sdkClient={authedSdkClient} />
})

export default Socket
