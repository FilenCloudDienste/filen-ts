import { ChatTypingType } from "@filen/sdk-rs"
import { useTranslation } from "react-i18next"
import { type Chat } from "@/types"
import { useRef, useEffect, Fragment, useCallback } from "react"
import { TextInput, type View as TView, useWindowDimensions, type TextInputSelectionChangeEvent, type ScaledSize } from "react-native"
import View, { KeyboardStickyView, CrossGlassContainerView } from "@/components/ui/view"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { useResolveClassNames } from "uniwind"
import { AnimatedView } from "@/components/ui/animated"
import { FadeIn, FadeOut } from "react-native-reanimated"
import useViewLayout from "@/hooks/useViewLayout"
import Ionicons from "@expo/vector-icons/Ionicons"
import { PressableScale } from "@/components/ui/pressables"
import useChatsStore, { type ChatMessageWithInflightId } from "@/features/chats/store/useChats.store"
import { useShallow } from "zustand/shallow"
import { useSecureStore } from "@/lib/secureStore"
import { cn, run, Semaphore, runEffect } from "@filen/utils"
import { useStringifiedClient } from "@/lib/auth"
import { makeDriveItemPublicLink } from "@/lib/sdkUnwrap"
import useEffectOnce from "@/hooks/useEffectOnce"
import { randomUUID } from "expo-crypto"
import chats from "@/features/chats/chats"
import { sync } from "@/features/chats/components/sync"
import useIsOnline from "@/hooks/useIsOnline"
import alerts from "@/lib/alerts"
import { runWithLoading } from "@/components/ui/fullScreenLoadingModal"
import events from "@/lib/events"
import { chatMessagesQueryUpdate } from "@/features/chats/queries/useChatMessages.query"
import Menu from "@/components/ui/menu"
import * as DocumentPicker from "expo-document-picker"
import * as ImagePicker from "expo-image-picker"
import * as FileSystem from "expo-file-system"
import { hasAllNeededMediaPermissions } from "@/hooks/useMediaPermissions"
import { selectDriveItems } from "@/features/drive/screens/driveSelect"
import drive from "@/features/drive/drive"
import useAccountQuery from "@/queries/useAccount.query"
import MentionSuggestions from "@/features/chats/components/chat/input/mentionSuggestions"
import EmojiSuggestions from "@/features/chats/components/chat/input/emojiSuggestions"
import ReplyTo from "@/features/chats/components/chat/input/replyTo"
import { withSystemPresentation } from "@/lib/systemPresentation"

type ChatTextInputProps = {
	chatInputValue: string
	onChangeText: (text: string) => void
	inputRef: React.RefObject<TextInput | null>
	onKeyPress: () => void
	onFocus: () => void
	onBlur: () => void
	onSelectionChange: (e: TextInputSelectionChangeEvent) => void
	onSend: () => void
	windowDimensions: ScaledSize
}

const ChatTextInput = ({
	chatInputValue,
	onChangeText,
	inputRef,
	onKeyPress,
	onFocus,
	onBlur,
	onSelectionChange,
	onSend,
	windowDimensions
}: ChatTextInputProps) => {
	const { t } = useTranslation()
	const suggestionsVisible = useChatsStore(useShallow(state => state.suggestionsVisible))
	const disableAssist = suggestionsVisible.length > 0 || chatInputValue.length === 0

	return (
		<CrossGlassContainerView className="flex-1 rounded-3xl min-h-11">
			<View className="flex-1 bg-transparent">
				<TextInput
					ref={inputRef}
					value={chatInputValue}
					onChangeText={onChangeText}
					className="ios:py-3 text-foreground min-h-11 flex-1 rounded-3xl py-2 pl-3 pr-12 leading-5"
					placeholderTextColorClassName="text-muted-foreground"
					placeholder={t("type_a_message")}
					multiline={true}
					scrollEnabled={true}
					autoFocus={false}
					autoCapitalize={disableAssist ? "none" : undefined}
					autoComplete={disableAssist ? "off" : undefined}
					autoCorrect={disableAssist ? false : undefined}
					spellCheck={disableAssist ? false : undefined}
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
						onPress={onSend}
						hitSlop={15}
						enabled={chatInputValue.trim().length > 0}
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
	)
}

const Input = ({ chat }: { chat: Chat }) => {
	const { t } = useTranslation()
	const insets = useSafeAreaInsets()
	const inputViewRef = useRef<TView>(null)
	const { onLayout: inputViewOnLayout, layout: inputViewLayout } = useViewLayout(inputViewRef)
	const textForeground = useResolveClassNames("text-foreground")
	const windowDimensions = useWindowDimensions()
	const [chatInputValue, setChatInputValue] = useSecureStore<string>(`chatInputValue:${chat.uuid}`, "")
	const inputRef = useRef<TextInput>(null)
	const isSendingRef = useRef(false)
	const stringifiedClient = useStringifiedClient()
	const typingTimeoutRef = useRef<ReturnType<typeof setTimeout>>(undefined)
	const sendTypingEventSemaphoreRef = useRef<Semaphore>(new Semaphore(1))
	const [chatReplyTo, setChatReplyTo] = useSecureStore<ChatMessageWithInflightId | null>(`chatReplyTo:${chat.uuid}`, null)
	const [chatEditMessage, setChatEditMessage] = useSecureStore<ChatMessageWithInflightId | null>(`chatEditMessage:${chat.uuid}`, null)
	const isOnline = useIsOnline()

	const accountQuery = useAccountQuery()

	const userIsSubbed = accountQuery.status === "success" && accountQuery.data.subs.filter(sub => Number(sub.activated) === 1).length > 0

	const insertLinksIntoInput = (links: string[]) => {
		const replacedMessage = chatInputValue.trim().length === 0 ? `${links.join("\n")} ` : `${chatInputValue} ${links.join("\n")}`

		if (replacedMessage.length === 0) {
			return
		}

		setChatInputValue(replacedMessage)

		useChatsStore.getState().setInputSelection({
			start: replacedMessage.length,
			end: replacedMessage.length
		})
	}

	const uploadAssetsAndInsert = async (assets: Parameters<typeof chats.uploadAssetsAndGenerateLinks>[0]) => {
		const result = await runWithLoading(async () => {
			return await chats.uploadAssetsAndGenerateLinks(assets)
		})

		if (!result.success) {
			console.error(result.error)
			alerts.error(result.error)

			return
		}

		if (result.data.length === 0) {
			return
		}

		insertLinksIntoInput(result.data)
	}

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
		if (isSendingRef.current) {
			return
		}

		if (!stringifiedClient || !me) {
			return
		}

		const normalizedMessage = chatInputValue.trim()

		if (normalizedMessage.length === 0) {
			return
		}

		isSendingRef.current = true

		try {
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
				sentTimestamp: BigInt(sentTimestamp),
				undecryptable: false
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
		} finally {
			isSendingRef.current = false
		}
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
					disabled={!userIsSubbed || !isOnline}
					buttons={[
						{
							id: "addMedia",
							title: t("add_photos_or_videos_from_gallery"),
							icon: "image",
							onPress: async () => {
								const permissionsResult = await run(async () => {
									return await withSystemPresentation(() =>
										hasAllNeededMediaPermissions({
											shouldRequest: true
										})
									)
								})

								if (!permissionsResult.success) {
									console.error(permissionsResult.error)
									alerts.error(permissionsResult.error)

									return
								}

								if (!permissionsResult.data) {
									alerts.error(t("no_permissions_enable_manually"))

									return
								}

								const imagePickerResult = await run(async () => {
									return await withSystemPresentation(() =>
										ImagePicker.launchImageLibraryAsync({
											mediaTypes: ["images", "videos"],
											exif: false,
											base64: false,
											quality: 1,
											allowsMultipleSelection: true,
											presentationStyle: ImagePicker.UIImagePickerPresentationStyle.PAGE_SHEET,
											shouldDownloadFromNetwork: true
										})
									)
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
									} satisfies Parameters<typeof chats.uploadAssetsAndGenerateLinks>[0][number]
								})

								await uploadAssetsAndInsert(assets)
							}
						},
						{
							id: "takeMedia",
							title: t("take_photo_or_video"),
							icon: "camera",
							onPress: async () => {
								const permissionsResult = await run(async () => {
									return await withSystemPresentation(() =>
										hasAllNeededMediaPermissions({
											shouldRequest: true
										})
									)
								})

								if (!permissionsResult.success) {
									console.error(permissionsResult.error)
									alerts.error(permissionsResult.error)

									return
								}

								if (!permissionsResult.data) {
									alerts.error(t("no_permissions_enable_manually"))

									return
								}

								const imagePickerResult = await run(async () => {
									return await withSystemPresentation(() =>
										ImagePicker.launchCameraAsync({
											mediaTypes: ["images", "videos"],
											exif: false,
											base64: false,
											quality: 1,
											allowsMultipleSelection: true,
											presentationStyle: ImagePicker.UIImagePickerPresentationStyle.PAGE_SHEET,
											shouldDownloadFromNetwork: true
										})
									)
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
									} satisfies Parameters<typeof chats.uploadAssetsAndGenerateLinks>[0][number]
								})

								await uploadAssetsAndInsert(assets)
							}
						},
						{
							id: "addFiles",
							title: t("add_files"),
							icon: "upload",
							onPress: async () => {
								const documentPickerResult = await run(async () => {
									return await withSystemPresentation(() =>
										DocumentPicker.getDocumentAsync({
											type: "*/*",
											multiple: true,
											copyToCacheDirectory: true,
											base64: false
										})
									)
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

								await uploadAssetsAndInsert(assets)
							}
						},
						{
							id: "addDriveItems",
							title: t("add_drive_items"),
							icon: "folder",
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

								insertLinksIntoInput(validLinks)
							}
						}
					]}
				>
					<CrossGlassContainerView disableInteraction={!userIsSubbed}>
						<PressableScale
							className={cn("items-center justify-center size-11", !userIsSubbed && "opacity-50 pointer-events-none")}
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
				<ChatTextInput
					chatInputValue={chatInputValue}
					onChangeText={onChangeText}
					inputRef={inputRef}
					onKeyPress={onKeyPress}
					onFocus={onFocus}
					onBlur={onBlur}
					onSelectionChange={onSelectionChange}
					onSend={send}
					windowDimensions={windowDimensions}
				/>
			</View>
		</KeyboardStickyView>
	)
}

export default Input
