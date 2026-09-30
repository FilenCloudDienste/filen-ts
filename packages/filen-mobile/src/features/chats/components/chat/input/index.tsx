import { useTranslation } from "react-i18next"
import { type Chat } from "@/types"
import { useRef, useEffect, Fragment } from "react"
import { TextInput, useWindowDimensions, type TextInputSelectionChangeEvent, type ScaledSize } from "react-native"
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
import { chatInputValueKey, chatReplyToKey, chatEditMessageKey } from "@/features/chats/chatDrafts"
import { cn, run, runOrThrow, runEffect } from "@filen/shared"
import { useStringifiedClient } from "@/lib/auth"
import { makeDriveItemPublicLink } from "@/lib/sdkUnwrap"
import useEffectOnce from "@/hooks/useEffectOnce"
import { randomUUID } from "expo-crypto"
import chats from "@/features/chats/chats"
import { signalTyping, signalStopped } from "@/features/chats/typing"
import { sync } from "@/features/chats/components/sync"
import useIsOnline from "@/hooks/useIsOnline"
import alerts from "@/lib/alerts"
import i18n from "@/lib/i18n"
import { runWithLoading } from "@/components/ui/fullScreenLoadingModal"
import events from "@/lib/events"
import { chatMessagesQueryUpdate } from "@/features/chats/queries/useChatMessages.query"
import { shouldSuppressKeyboardSuggestions } from "@/features/chats/utils"
import Menu from "@/components/ui/menu"
import { pickDocuments } from "@/lib/documentPicker"
import { pickMedia, pickedAssetName, type MediaSource } from "@/lib/mediaPicker"
import { selectDriveItems } from "@/features/drive/driveSelectSession"
import drive from "@/features/drive/drive"
import useAccountQuery, { isAccountSubscribed } from "@/queries/useAccount.query"
import MentionSuggestions from "@/features/chats/components/chat/input/mentionSuggestions"
import EmojiSuggestions from "@/features/chats/components/chat/input/emojiSuggestions"
import ReplyTo from "@/features/chats/components/chat/input/replyTo"
import logger from "@/lib/logger"

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
	// Capitalization is left to the keyboard entirely: it was this condition's former empty-input arm
	// that stopped the first letter of every message from being capitalized.
	const autocompleteOpen = shouldSuppressKeyboardSuggestions(suggestionsVisible)

	return (
		<CrossGlassContainerView className="flex-1 rounded-3xl min-h-11">
			<View className="flex-1 bg-transparent">
				<TextInput
					ref={inputRef}
					value={chatInputValue}
					onChangeText={onChangeText}
					className="ios:py-3 text-foreground min-h-11 flex-1 rounded-3xl py-2 pl-3 pr-12 leading-5"
					placeholderTextColorClassName="accent-muted-foreground"
					placeholder={t("type_a_message")}
					multiline={true}
					scrollEnabled={true}
					autoFocus={false}
					autoComplete={autocompleteOpen ? "off" : undefined}
					autoCorrect={autocompleteOpen ? false : undefined}
					spellCheck={autocompleteOpen ? false : undefined}
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
						rippleColor="transparent"
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

// M3: sync.flushToDisk never throws — persistence failure comes back as `false`
// (sync-internal callers ignore it; their next pass re-flushes). HERE it must surface:
// a failed SQLite write means the message the user just sent survives in memory only and
// would die with the process, with zero signal otherwise. Exported so the test exercises
// the live helper (T5 pattern). Callers still proceed to kick the send — getting the
// message to the server is the best remaining chance of not losing it.
export async function flushInflightMessagesWithAlert(): Promise<void> {
	const flushed = await sync.flushToDisk(useChatsStore.getState().inflightMessages)

	if (!flushed) {
		alerts.error(i18n.t("chat_message_not_saved_to_device"))
	}
}

const Input = ({ chat }: { chat: Chat }) => {
	const { t } = useTranslation()
	const insets = useSafeAreaInsets()
	const { onLayout: inputViewOnLayout, layout: inputViewLayout } = useViewLayout()
	const textForeground = useResolveClassNames("text-foreground")
	const windowDimensions = useWindowDimensions()
	const [chatInputValue, setChatInputValue] = useSecureStore<string>(chatInputValueKey(chat.uuid), "")
	const inputRef = useRef<TextInput>(null)
	const isSendingRef = useRef(false)
	const stringifiedClient = useStringifiedClient()
	const [chatReplyTo, setChatReplyTo] = useSecureStore<ChatMessageWithInflightId | null>(chatReplyToKey(chat.uuid), null)
	const [chatEditMessage, setChatEditMessage] = useSecureStore<ChatMessageWithInflightId | null>(chatEditMessageKey(chat.uuid), null)
	const isOnline = useIsOnline()

	const accountQuery = useAccountQuery()

	const userIsSubbed = isAccountSubscribed(accountQuery)

	// Read through a ref so the attach menu's handlers, and the native menu config built from them, don't change on
	// every keystroke. Links land only after an upload behind the full-screen loader, so the committed draft is current.
	const chatInputValueRef = useRef(chatInputValue)

	useEffect(() => {
		chatInputValueRef.current = chatInputValue
	})

	const insertLinksIntoInput = (links: string[]) => {
		const draft = chatInputValueRef.current
		const replacedMessage = draft.trim().length === 0 ? `${links.join("\n")} ` : `${draft} ${links.join("\n")}`

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
			logger.error("chats", "uploadAssetsAndInsert failed", { error: result.error })
			alerts.error(result.error)

			return
		}

		if (result.data.length === 0) {
			return
		}

		insertLinksIntoInput(result.data)
	}

	const pickAndInsert = async (source: MediaSource) => {
		const picked = await pickMedia({ source })

		if (!picked) {
			return
		}

		await uploadAssetsAndInsert(
			picked.map(asset => ({
				uri: asset.uri,
				name: pickedAssetName(asset),
				mimeType: asset.mimeType
			}))
		)
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

		// runOrThrow, not try/finally: the React Compiler skips a component containing try/finally.
		await runOrThrow(async defer => {
			defer(() => {
				isSendingRef.current = false
			})

			signalStopped(chat)

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
					logger.error("chats", "editMessage failed", { error: result.error })
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

			// M3: alerts when the SQLite write fails (the message is memory-only) but never
			// bails — the sync kick below is the best remaining chance of delivering it.
			await flushInflightMessagesWithAlert()

			sync.syncNow()
		})
	}

	const onKeyPress = () => {
		signalTyping(chat)
	}

	const onBlur = () => {
		useChatsStore.getState().setInputFocused(false)

		signalStopped(chat)
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

	// Latest chat in a ref so the cleanup below runs on UNMOUNT only. Depending on chat directly
	// re-ran the cleanup whenever the chat object was replaced in the query (any incoming message
	// rewrites it), firing a spurious Typing.Up mid-typing — peers saw the indicator flicker off
	// while the user never stopped.
	const chatRef = useRef(chat)

	useEffect(() => {
		chatRef.current = chat
	})

	useEffect(() => {
		return () => {
			signalStopped(chatRef.current)
		}
	}, [])

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
							onPress: () => pickAndInsert("library")
						},
						{
							id: "takeMedia",
							title: t("take_photo_or_video"),
							icon: "camera",
							onPress: () => pickAndInsert("camera")
						},
						{
							id: "addFiles",
							title: t("add_files"),
							icon: "upload",
							onPress: async () => {
								const documentPickerResult = await run(async () => {
									return await pickDocuments({
										type: "*/*",
										multiple: true
									})
								})

								if (!documentPickerResult.success) {
									logger.error("chats", "addFiles document picker failed", { error: documentPickerResult.error })
									alerts.error(documentPickerResult.error)

									return
								}

								if (documentPickerResult.data.canceled) {
									return
								}

								const assets = documentPickerResult.data.documents

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
										directories: false
									})
								})

								if (!selectDriveItemsResult.success) {
									logger.error("chats", "addDriveItems drive select failed", { error: selectDriveItemsResult.error })
									alerts.error(selectDriveItemsResult.error)

									return
								}

								if (selectDriveItemsResult.data.cancelled) {
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
									logger.error("chats", "addDriveItems enable public link failed", { error: result.error })
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
