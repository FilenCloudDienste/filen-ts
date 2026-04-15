import { type Chat, type ChatParticipant, ChatTypingType, AnyNormalDir } from "@filen/sdk-rs"
import { useRef, useEffect, Fragment, memo, useCallback } from "react"
import { TextInput, type View as TView, useWindowDimensions, type TextInputSelectionChangeEvent } from "react-native"
import View, { KeyboardStickyView, CrossGlassContainerView, GestureHandlerScrollView } from "@/components/ui/view"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import Text from "@/components/ui/text"
import { useResolveClassNames } from "uniwind"
import { AnimatedView } from "@/components/ui/animated"
import { FadeIn, FadeOut, SlideInDown, SlideOutDown } from "react-native-reanimated"
import useViewLayout from "@/hooks/useViewLayout"
import Ionicons from "@expo/vector-icons/Ionicons"
import { PressableScale } from "@/components/ui/pressables"
import useChatsStore, { type ChatMessageWithInflightId } from "@/stores/useChats.store"
import { useShallow } from "zustand/shallow"
import { useSecureStore } from "@/lib/secureStore"
import { cn, fastLocaleCompare, run, Semaphore, runEffect, findClosestIndexString } from "@filen/utils"
import { useStringifiedClient } from "@/lib/auth"
import { contactDisplayName, unwrapFileMeta, unwrappedFileIntoDriveItem, makeDriveItemPublicLink } from "@/lib/utils"
import Avatar from "@/components/ui/avatar"
import useEffectOnce from "@/hooks/useEffectOnce"
import Image from "@/components/ui/image"
import { customEmojis } from "@/assets/customEmojis"
import { randomUUID } from "expo-crypto"
import chats from "@/lib/chats"
import { sync } from "@/components/chats/sync"
import alerts from "@/lib/alerts"
import { runWithLoading } from "@/components/ui/fullScreenLoadingModal"
import events from "@/lib/events"
import { chatMessagesQueryUpdate } from "@/queries/useChatMessages.query"
import Menu from "@/components/ui/menu"
import * as DocumentPicker from "expo-document-picker"
import * as ImagePicker from "expo-image-picker"
import * as FileSystem from "expo-file-system"
import { hasAllNeededMediaPermissions } from "@/hooks/useMediaPermissions"
import { selectDriveItems } from "@/routes/driveSelect/[uuid]"
import transfers from "@/lib/transfers"
import drive from "@/lib/drive"

const PopupContainerView = memo(
	({
		children,
		className,
		scrollViewClassName,
		containerClassName,
		scrollViewProps
	}: {
		children: React.ReactNode
		className?: string
		scrollViewClassName?: string
		containerClassName?: string
		scrollViewProps?: React.ComponentProps<typeof GestureHandlerScrollView>
	}) => {
		const inputViewLayout = useChatsStore(useShallow(state => state.inputViewLayout))
		const windowDimensions = useWindowDimensions()

		return (
			<AnimatedView
				entering={SlideInDown}
				exiting={SlideOutDown}
				className={cn("absolute left-0 right-0 px-4 z-20", className)}
				style={{
					bottom: inputViewLayout.height + 8
				}}
			>
				<CrossGlassContainerView
					className={cn("rounded-3xl w-full overflow-hidden", containerClassName)}
					disableLiquidGlass={true}
				>
					<GestureHandlerScrollView
						showsHorizontalScrollIndicator={false}
						showsVerticalScrollIndicator={true}
						className={cn("px-3 py-2", scrollViewClassName)}
						automaticallyAdjustContentInsets={true}
						style={{
							maxHeight: Math.max(128, windowDimensions.height / 4)
						}}
						{...scrollViewProps}
					>
						{children}
					</GestureHandlerScrollView>
				</CrossGlassContainerView>
			</AnimatedView>
		)
	}
)

export const MentionSuggestions = memo(({ chat }: { chat: Chat }) => {
	const [chatInputValue, setChatInputValue] = useSecureStore<string>(`chatInputValue:${chat.uuid}`, "")
	const stringifiedClient = useStringifiedClient()
	const inputSelection = useChatsStore(useShallow(state => state.inputSelection))
	const suggestionsVisible = useChatsStore(useShallow(state => state.suggestionsVisible))
	const inputFocused = useChatsStore(useShallow(state => state.inputFocused))

	const { show, text } = (() => {
		const valueNormalized = chatInputValue.toLowerCase()

		if (
			valueNormalized.length === 0 ||
			inputSelection.start === 0 ||
			suggestionsVisible.filter(s => s !== "mentions").length > 0 ||
			!inputFocused
		) {
			return {
				show: false,
				text: ""
			}
		}

		const closestIndex = findClosestIndexString(valueNormalized, "@", inputSelection.start)
		const sliced = valueNormalized.slice(closestIndex === -1 ? valueNormalized.lastIndexOf("@") : closestIndex, inputSelection.start)

		return {
			show:
				(sliced === "@" && valueNormalized.trim().length === 1) ||
				(sliced.startsWith("@") &&
					sliced.length >= 1 &&
					!sliced.includes(" ") &&
					!sliced.endsWith("@") &&
					!sliced.endsWith(" ") &&
					!valueNormalized
						.slice(0, closestIndex)
						.split(/[\s\n]+/)
						.at(-1)
						?.startsWith("@")),
			text: sliced
		}
	})()

	const participants = (() => {
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
	})()

	useEffect(() => {
		if (show) {
			useChatsStore.getState().setSuggestionsVisible(prev => [...prev.filter(s => s !== "mentions"), "mentions"])
		} else {
			useChatsStore.getState().setSuggestionsVisible(prev => prev.filter(s => s !== "mentions"))
		}
	}, [show])

	if (!show || participants.length === 0) {
		return null
	}

	return (
		<PopupContainerView scrollViewClassName="py-1">
			{participants.map(participant => {
				return (
					<PressableScale
						key={participant.userId}
						rippleColor="transparent"
						onPress={() => {
							if (chatInputValue.length === 0 || inputSelection.start === 0) {
								return
							}

							const closestIndex = findClosestIndexString(chatInputValue, "@", inputSelection.start)

							if (closestIndex === -1) {
								return
							}

							const replacedMessage = chatInputValue.slice(0, closestIndex) + `@${participant.email} `

							if (replacedMessage.length === 0) {
								return
							}

							setChatInputValue(replacedMessage)

							useChatsStore.getState().setInputSelection({
								start: replacedMessage.length,
								end: replacedMessage.length
							})
						}}
					>
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
					</PressableScale>
				)
			})}
		</PopupContainerView>
	)
})

const EmojiSuggestions = memo(({ chat }: { chat: Chat }) => {
	const [chatInputValue, setChatInputValue] = useSecureStore<string>(`chatInputValue:${chat.uuid}`, "")
	const inputSelection = useChatsStore(useShallow(state => state.inputSelection))
	const suggestionsVisible = useChatsStore(useShallow(state => state.suggestionsVisible))
	const inputFocused = useChatsStore(useShallow(state => state.inputFocused))

	const { show, text } = (() => {
		const valueNormalized = chatInputValue.toLowerCase()

		if (
			valueNormalized.length === 0 ||
			inputSelection.start === 0 ||
			suggestionsVisible.filter(s => s !== "emojis").length > 0 ||
			!inputFocused
		) {
			return {
				show: false,
				text: ""
			}
		}

		const closestIndex = findClosestIndexString(valueNormalized, ":", inputSelection.start)
		const sliced = valueNormalized.slice(closestIndex === -1 ? valueNormalized.lastIndexOf(":") : closestIndex, inputSelection.start)

		return {
			show:
				(sliced === ":" && valueNormalized.trim().length === 3) ||
				(sliced.startsWith(":") &&
					sliced.length >= 3 &&
					!sliced.includes(" ") &&
					!sliced.endsWith(":") &&
					!sliced.endsWith(" ") &&
					!valueNormalized
						.slice(0, closestIndex)
						.split(/[\s\n]+/)
						.at(-1)
						?.startsWith(":")),
			text: sliced
		}
	})()

	const emojis = (() => {
		const textNormalized = text.toLowerCase().trim().split(":").join("")

		return customEmojis
			.filter(e => e.name.toLowerCase().trim().includes(textNormalized))
			.slice(0, 10)
			.sort((a, b) => fastLocaleCompare(a.name, b.name))
	})()

	useEffect(() => {
		if (show) {
			useChatsStore.getState().setSuggestionsVisible(prev => [...prev.filter(s => s !== "emojis"), "emojis"])
		} else {
			useChatsStore.getState().setSuggestionsVisible(prev => prev.filter(s => s !== "emojis"))
		}
	}, [show])

	if (!show || emojis.length === 0) {
		return null
	}

	return (
		<PopupContainerView scrollViewClassName="py-1">
			{emojis.map(emoji => {
				return (
					<PressableScale
						key={emoji.id}
						rippleColor="transparent"
						onPress={() => {
							if (chatInputValue.length === 0 || inputSelection.start === 0) {
								return
							}

							const closestIndex = findClosestIndexString(chatInputValue, ":", inputSelection.start)

							if (closestIndex === -1) {
								return
							}

							const replacedMessage = chatInputValue.slice(0, closestIndex) + `:${emoji.name.toLowerCase().trim()}: `

							if (replacedMessage.length === 0) {
								return
							}

							setChatInputValue(replacedMessage)

							useChatsStore.getState().setInputSelection({
								start: replacedMessage.length,
								end: replacedMessage.length
							})
						}}
					>
						<View className="flex-row items-center gap-3 bg-transparent py-1.5">
							<Image
								className="shrink-0 w-7 h-7"
								recyclingKey={`emoji-${emoji.id}`}
								source={{
									uri: emoji.skins[0]!.src
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
					</PressableScale>
				)
			})}
		</PopupContainerView>
	)
})

async function uploadAssetsAndGenerateLinks(
	assets: {
		uri: string
		name: string
		lastModified?: number
		mimeType?: string
	}[]
): Promise<string[]> {
	const parent = new AnyNormalDir.Dir(await chats.getChatUploadsDirectory())

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
						mime: asset.mimeType,
						hideProgress: true
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

const ReplyTo = memo(({ chat }: { chat: Chat }) => {
	const [chatReplyTo, setChatReplyTo] = useSecureStore<ChatMessageWithInflightId | null>(`chatReplyTo:${chat.uuid}`, null)
	const suggestionsVisible = useChatsStore(useShallow(state => state.suggestionsVisible))
	const textMutedForeground = useResolveClassNames("text-muted-foreground")

	const info = ((): { show: false } | { show: true; participant: ChatParticipant } => {
		if (!chatReplyTo || suggestionsVisible.filter(s => s !== "reply").length > 0) {
			return {
				show: false
			}
		}

		const participant = chat.participants.find(p => p.userId === chatReplyTo.inner.senderId)

		if (!participant) {
			return {
				show: false
			}
		}

		return {
			show: true,
			participant
		}
	})()

	useEffect(() => {
		if (info.show) {
			useChatsStore.getState().setSuggestionsVisible(prev => [...prev.filter(s => s !== "reply"), "reply"])
		} else {
			useChatsStore.getState().setSuggestionsVisible(prev => prev.filter(s => s !== "reply"))
		}
	}, [info.show])

	if (!info.show || !chatReplyTo) {
		return null
	}

	return (
		<PopupContainerView
			scrollViewClassName="py-1"
			scrollViewProps={{
				scrollEnabled: false
			}}
		>
			<View className="flex-row items-center gap-3 bg-transparent py-1.5">
				<View className="flex-row items-center gap-3 bg-transparent">
					<Ionicons
						size={20}
						name="arrow-undo-outline"
						color={textMutedForeground.color}
						style={{
							transform: [
								{
									scaleX: -1
								}
							]
						}}
					/>
					<Avatar
						className="shrink-0"
						size={32}
						source={chatReplyTo?.inner.senderAvatar}
					/>
				</View>
				<View className="bg-transparent flex-1 flex-col">
					<Text
						className="flex-1"
						numberOfLines={1}
						ellipsizeMode="middle"
					>
						{contactDisplayName(info.participant)}
					</Text>
					<Text
						className="flex-1 text-xs text-muted-foreground"
						numberOfLines={1}
						ellipsizeMode="tail"
					>
						{chatReplyTo.inner.message}
					</Text>
				</View>
				<PressableScale
					className="flex-row items-center justify-center"
					onPress={() => {
						setChatReplyTo(null)
					}}
				>
					<Ionicons
						name="close-outline"
						size={20}
						color={textMutedForeground.color}
					/>
				</PressableScale>
			</View>
		</PopupContainerView>
	)
})

const Input = memo(({ chat }: { chat: Chat }) => {
	const insets = useSafeAreaInsets()
	const inputViewRef = useRef<TView>(null)
	const { onLayout: inputViewOnLayout, layout: inputViewLayout } = useViewLayout(inputViewRef)
	const textForeground = useResolveClassNames("text-foreground")
	const windowDimensions = useWindowDimensions()
	const [chatInputValue, setChatInputValue] = useSecureStore<string>(`chatInputValue:${chat.uuid}`, "")
	const inputRef = useRef<TextInput>(null)
	const suggestionsVisible = useChatsStore(useShallow(state => state.suggestionsVisible))
	const stringifiedClient = useStringifiedClient()
	const typingTimeoutRef = useRef<ReturnType<typeof setTimeout>>(undefined)
	const sendTypingEventSemaphoreRef = useRef<Semaphore>(new Semaphore(1))
	const [chatReplyTo, setChatReplyTo] = useSecureStore<ChatMessageWithInflightId | null>(`chatReplyTo:${chat.uuid}`, null)
	const [chatEditMessage, setChatEditMessage] = useSecureStore<ChatMessageWithInflightId | null>(`chatEditMessage:${chat.uuid}`, null)

	const onChangeText = (text: string) => {
		setChatInputValue(text)

		if (text.length === 0 && chatEditMessage) {
			setChatEditMessage(null)
		}
	}

	const me = (() => {
		if (!stringifiedClient) {
			return null
		}

		return chat.participants.find(p => p.userId === stringifiedClient.userId)
	})()

	const sendTypingEvent = useCallback(
		async (type: ChatTypingType) => {
			const result = await run(async defer => {
				await sendTypingEventSemaphoreRef.current.acquire()

				defer(() => {
					sendTypingEventSemaphoreRef.current.release()
				})

				await chats.sendTyping({
					chat,
					type
				})
			})

			if (!result.success) {
				console.error(result.error)

				return
			}
		},
		[chat]
	)

	const send = async () => {
		if (!stringifiedClient || !me) {
			return
		}

		const normalizedMessage = chatInputValue.trim()

		if (normalizedMessage.length === 0) {
			return
		}

		clearTimeout(typingTimeoutRef.current)
		sendTypingEvent(ChatTypingType.Up).catch(console.error)

		inputRef.current?.clear()

		setChatInputValue("")
		setChatReplyTo(null)

		useChatsStore.getState().setInputSelection({
			start: 0,
			end: 0
		})

		if (chatEditMessage) {
			const result = await runWithLoading(async () => {
				return await chats.editMessage({
					chat,
					message: chatEditMessage,
					newMessage: normalizedMessage
				})
			})

			if (!result.success) {
				console.error(result.error)
				alerts.error(result.error)

				setChatInputValue(normalizedMessage)

				useChatsStore.getState().setInputSelection({
					start: normalizedMessage.length,
					end: normalizedMessage.length
				})

				return
			}

			setChatEditMessage(null)

			return
		}

		const sentTimestamp = Date.now()
		const inflightId = randomUUID()
		const inflightMessage: ChatMessageWithInflightId = {
			inflightId,
			chat: chat.uuid,
			inner: {
				uuid: inflightId,
				senderId: stringifiedClient.userId,
				senderEmail: stringifiedClient.email,
				senderAvatar: me.avatar,
				senderNickName: me.nickName,
				message: normalizedMessage
			},
			replyTo: chatReplyTo
				? {
						uuid: chatReplyTo.inner.uuid,
						senderId: chatReplyTo.inner.senderId,
						senderEmail: chatReplyTo.inner.senderEmail,
						senderAvatar: chatReplyTo.inner.senderAvatar,
						senderNickName: chatReplyTo.inner.senderNickName,
						message: chatReplyTo.inner.message
					}
				: undefined,
			embedDisabled: false,
			edited: false,
			editedTimestamp: BigInt(0),
			sentTimestamp: BigInt(sentTimestamp)
		}

		chatMessagesQueryUpdate({
			params: {
				uuid: chat.uuid
			},
			updater: messages => [...messages.filter(m => m.inflightId !== inflightMessage.inflightId), inflightMessage]
		})

		useChatsStore.getState().setInflightMessages(prev => ({
			...prev,
			[chat.uuid]: {
				chat,
				messages: [...(prev[chat.uuid]?.messages ?? []), inflightMessage]
			}
		}))

		const result = await run(async () => {
			await sync.flushToDisk(useChatsStore.getState().inflightMessages)
		})

		if (!result.success) {
			console.error(result.error)
			alerts.error(result.error)

			return
		}

		sync.syncNow()
	}

	const onKeyPress = () => {
		sendTypingEvent(ChatTypingType.Down).catch(console.error)

		clearTimeout(typingTimeoutRef.current)

		typingTimeoutRef.current = setTimeout(() => {
			sendTypingEvent(ChatTypingType.Up).catch(console.error)
		}, 3000)
	}

	const onBlur = () => {
		useChatsStore.getState().setInputFocused(false)

		clearTimeout(typingTimeoutRef.current)
		sendTypingEvent(ChatTypingType.Up).catch(console.error)
	}

	const onFocus = () => {
		useChatsStore.getState().setInputFocused(true)
	}

	const onSelectionChange = (e: TextInputSelectionChangeEvent) => {
		useChatsStore.getState().setInputSelection(e.nativeEvent.selection)
	}

	useEffectOnce(() => {
		if (chatInputValue.length === 0) {
			return
		}

		useChatsStore.getState().setInputSelection({
			start: chatInputValue.length,
			end: chatInputValue.length
		})
	})

	useEffect(() => {
		const { cleanup } = runEffect(defer => {
			const focusChatInputSubscription = events.subscribe("focusChatInput", data => {
				if (data.chatUuid !== chat.uuid) {
					return
				}

				setTimeout(() => {
					inputRef.current?.focus()
				}, 100)
			})

			defer(() => {
				focusChatInputSubscription.remove()
			})
		})

		return () => {
			cleanup()
		}
	}, [chat.uuid])

	useEffect(() => {
		useChatsStore.getState().setInputViewLayout(inputViewLayout)
	}, [inputViewLayout])

	useEffect(() => {
		return () => {
			clearTimeout(typingTimeoutRef.current)
			sendTypingEvent(ChatTypingType.Up).catch(console.error)
		}
	}, [sendTypingEvent])

	return (
		<KeyboardStickyView
			className="bg-transparent absolute left-0 right-0 bottom-0"
			offset={{
				opened: -16,
				closed: -(insets.bottom + 8)
			}}
		>
			{chatInputValue.length > 0 && (
				<Fragment>
					<MentionSuggestions chat={chat} />
					<EmojiSuggestions chat={chat} />
				</Fragment>
			)}
			<ReplyTo chat={chat} />
			<View
				className="bg-transparent flex-row items-end gap-2 px-4"
				ref={inputViewRef}
				onLayout={inputViewOnLayout}
			>
				<Menu
					type="dropdown"
					buttons={[
						{
							id: "addMedia",
							title: "tbd_add_photos_or_videos_from_gallery",
							onPress: async () => {
								const permissionsResult = await run(async () => {
									return await hasAllNeededMediaPermissions({
										shouldRequest: true
									})
								})

								if (!permissionsResult.success) {
									console.error(permissionsResult.error)
									alerts.error(permissionsResult.error)

									return
								}

								if (!permissionsResult.data) {
									alerts.error("tbd_no_permissions_enable_manually")

									return
								}

								const imagePickerResult = await run(async () => {
									return await ImagePicker.launchImageLibraryAsync({
										mediaTypes: ["images", "videos"],
										exif: false,
										base64: false,
										quality: 1,
										allowsMultipleSelection: true,
										presentationStyle: ImagePicker.UIImagePickerPresentationStyle.PAGE_SHEET,
										shouldDownloadFromNetwork: true
									})
								})

								if (!imagePickerResult.success) {
									console.error(imagePickerResult.error)
									alerts.error(imagePickerResult.error)

									return
								}

								if (imagePickerResult.data.canceled) {
									return
								}

								const assets = imagePickerResult.data.assets.map(asset => {
									const extname = FileSystem.Paths.extname(asset.uri)
									const fileName = asset.fileName ?? `${randomUUID()}${extname}`

									return {
										uri: asset.uri,
										name: fileName,
										mimeType: asset.mimeType
									} satisfies Parameters<typeof uploadAssetsAndGenerateLinks>[0][number]
								})

								const result = await runWithLoading(async () => {
									return await uploadAssetsAndGenerateLinks(assets)
								})

								if (!result.success) {
									console.error(result.error)
									alerts.error(result.error)

									return
								}

								if (result.data.length === 0) {
									return
								}

								const replacedMessage =
									chatInputValue.trim().length === 0
										? `${result.data.join("\n")} `
										: `${chatInputValue} ${result.data.join("\n")}`

								if (replacedMessage.length === 0) {
									return
								}

								setChatInputValue(replacedMessage)

								useChatsStore.getState().setInputSelection({
									start: replacedMessage.length,
									end: replacedMessage.length
								})
							}
						},
						{
							id: "takeMedia",
							title: "tbd_take_photo_or_video",
							onPress: async () => {
								const permissionsResult = await run(async () => {
									return await hasAllNeededMediaPermissions({
										shouldRequest: true
									})
								})

								if (!permissionsResult.success) {
									console.error(permissionsResult.error)
									alerts.error(permissionsResult.error)

									return
								}

								if (!permissionsResult.data) {
									alerts.error("tbd_no_permissions_enable_manually")

									return
								}

								const imagePickerResult = await run(async () => {
									return await ImagePicker.launchCameraAsync({
										mediaTypes: ["images", "videos"],
										exif: false,
										base64: false,
										quality: 1,
										allowsMultipleSelection: true,
										presentationStyle: ImagePicker.UIImagePickerPresentationStyle.PAGE_SHEET,
										shouldDownloadFromNetwork: true
									})
								})

								if (!imagePickerResult.success) {
									console.error(imagePickerResult.error)
									alerts.error(imagePickerResult.error)

									return
								}

								if (imagePickerResult.data.canceled) {
									return
								}

								const assets = imagePickerResult.data.assets.map(asset => {
									const extname = FileSystem.Paths.extname(asset.uri)
									const fileName = asset.fileName ?? `${randomUUID()}${extname}`

									return {
										uri: asset.uri,
										name: fileName,
										mimeType: asset.mimeType
									} satisfies Parameters<typeof uploadAssetsAndGenerateLinks>[0][number]
								})

								const result = await runWithLoading(async () => {
									return await uploadAssetsAndGenerateLinks(assets)
								})

								if (!result.success) {
									console.error(result.error)
									alerts.error(result.error)

									return
								}

								if (result.data.length === 0) {
									return
								}

								const replacedMessage =
									chatInputValue.trim().length === 0
										? `${result.data.join("\n")} `
										: `${chatInputValue} ${result.data.join("\n")}`

								if (replacedMessage.length === 0) {
									return
								}

								setChatInputValue(replacedMessage)

								useChatsStore.getState().setInputSelection({
									start: replacedMessage.length,
									end: replacedMessage.length
								})
							}
						},
						{
							id: "addFiles",
							title: "tbd_add_files",
							onPress: async () => {
								const documentPickerResult = await run(async () => {
									return await DocumentPicker.getDocumentAsync({
										type: "*/*",
										multiple: true,
										copyToCacheDirectory: true,
										base64: false
									})
								})

								if (!documentPickerResult.success) {
									console.error(documentPickerResult.error)
									alerts.error(documentPickerResult.error)

									return
								}

								if (documentPickerResult.data.canceled) {
									return
								}

								const assets = documentPickerResult.data.assets

								const result = await runWithLoading(async () => {
									return await uploadAssetsAndGenerateLinks(assets)
								})

								if (!result.success) {
									console.error(result.error)
									alerts.error(result.error)

									return
								}

								if (result.data.length === 0) {
									return
								}

								const replacedMessage =
									chatInputValue.trim().length === 0
										? `${result.data.join("\n")} `
										: `${chatInputValue} ${result.data.join("\n")}`

								if (replacedMessage.length === 0) {
									return
								}

								setChatInputValue(replacedMessage)

								useChatsStore.getState().setInputSelection({
									start: replacedMessage.length,
									end: replacedMessage.length
								})
							}
						},
						{
							id: "addDriveItems",
							title: "tbd_add_drive_items",
							onPress: async () => {
								const selectDriveItemsResult = await run(async () => {
									return await selectDriveItems({
										type: "multiple",
										files: true,
										directories: false,
										items: []
									})
								})

								if (!selectDriveItemsResult.success) {
									console.error(selectDriveItemsResult.error)
									alerts.error(selectDriveItemsResult.error)

									return
								}

								if (selectDriveItemsResult.data.cancelled || selectDriveItemsResult.data.selectedItems.length === 0) {
									return
								}

								const items = selectDriveItemsResult.data.selectedItems

								const result = await runWithLoading(async () => {
									return await Promise.all(
										items.map(async item => {
											if (item.type !== "driveItem") {
												return null
											}

											const link = await drive.enablePublicLink({
												item: item.data
											})

											return makeDriveItemPublicLink({
												item: item.data,
												linkUuid: link.link.linkUuid
											})
										})
									)
								})

								if (!result.success) {
									console.error(result.error)
									alerts.error(result.error)

									return
								}

								const validLinks = result.data.filter((l): l is NonNullable<typeof l> => l !== null)

								if (validLinks.length === 0) {
									return
								}

								const replacedMessage =
									chatInputValue.trim().length === 0
										? `${validLinks.join("\n")} `
										: `${chatInputValue} ${validLinks.join("\n")}`

								if (replacedMessage.length === 0) {
									return
								}

								setChatInputValue(replacedMessage)

								useChatsStore.getState().setInputSelection({
									start: replacedMessage.length,
									end: replacedMessage.length
								})
							}
						}
					]}
				>
					<CrossGlassContainerView>
						<PressableScale
							className="items-center justify-center size-11"
							rippleColor="transparent"
						>
							<Ionicons
								name="add-outline"
								size={24}
								color={textForeground.color}
							/>
						</PressableScale>
					</CrossGlassContainerView>
				</Menu>
				<CrossGlassContainerView className="flex-1 rounded-3xl min-h-11">
					<View className="flex-1 bg-transparent">
						<TextInput
							ref={inputRef}
							value={chatInputValue}
							onChangeText={onChangeText}
							className="ios:py-3 text-foreground min-h-11 flex-1 rounded-3xl py-2 pl-3 pr-12 leading-5"
							placeholderTextColorClassName="text-muted-foreground"
							placeholder="tbd_type_a_message"
							multiline={true}
							scrollEnabled={true}
							autoFocus={false}
							autoCapitalize={suggestionsVisible.length > 0 || chatInputValue.length === 0 ? "none" : undefined}
							autoComplete={suggestionsVisible.length > 0 || chatInputValue.length === 0 ? "off" : undefined}
							autoCorrect={suggestionsVisible.length > 0 || chatInputValue.length === 0 ? false : undefined}
							spellCheck={suggestionsVisible.length > 0 || chatInputValue.length === 0 ? false : undefined}
							keyboardType="default"
							returnKeyType="default"
							enterKeyHint="enter"
							onKeyPress={onKeyPress}
							onFocus={onFocus}
							onBlur={onBlur}
							onSelectionChange={onSelectionChange}
							style={{
								maxHeight: Math.max(128, windowDimensions.height / 4)
							}}
						/>
						<AnimatedView
							className="absolute z-50 bottom-2 right-2"
							entering={FadeIn}
							exiting={FadeOut}
						>
							<PressableScale
								className="ios:rounded-full rounded-full size-7 bg-blue-500 items-center justify-center"
								onPress={send}
								hitSlop={15}
							>
								<Ionicons
									name="arrow-up-outline"
									size={18}
									color="white"
								/>
							</PressableScale>
						</AnimatedView>
					</View>
				</CrossGlassContainerView>
			</View>
		</KeyboardStickyView>
	)
})

export default Input
