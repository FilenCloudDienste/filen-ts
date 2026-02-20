import { Fragment, useState } from "react"
import SafeAreaView from "@/components/ui/safeAreaView"
import StackHeader, { type HeaderItem } from "@/components/ui/header"
import { memo, useMemo, useCallback } from "@/lib/memo"
import { Platform, TextInput } from "react-native"
import List from "@/components/chats/list"
import { useShallow } from "zustand/shallow"
import useChatsStore from "@/stores/useChats.store"
import useChatsQuery from "@/queries/useChats.query"
import { useStringifiedClient } from "@/lib/auth"
import { useFocusEffect } from "expo-router"
import { useResolveClassNames } from "uniwind"
import chatsLib from "@/lib/chats"
import { runWithLoading } from "@/components/ui/fullScreenLoadingModal"
import alerts from "@/lib/alerts"
import { run } from "@filen/utils"
import prompts from "@/lib/prompts"
import View, { KeyboardAvoidingView } from "@/components/ui/view"
import type { MenuButton } from "@/components/ui/menu"
import type { SearchBarProps } from "react-native-screens"

const Header = memo(({ setSearchQuery }: { setSearchQuery?: React.Dispatch<React.SetStateAction<string>> }) => {
	const stringigiedClient = useStringifiedClient()
	const selectedChats = useChatsStore(useShallow(state => state.selectedChats))
	const textForeground = useResolveClassNames("text-foreground")
	const selectedChatsIncludesMuted = useChatsStore(useShallow(state => state.selectedChats.some(chat => chat.muted)))
	const everySelectedChatOwnedBySelf = useChatsStore(
		useShallow(state => state.selectedChats.every(chat => chat.ownerId === stringigiedClient?.userId))
	)
	const selfIsParticipantAndNotOwnerOfEverySelectedChat = useChatsStore(
		useShallow(state =>
			state.selectedChats.every(
				chat =>
					chat.ownerId !== stringigiedClient?.userId &&
					chat.participants.some(participant => participant.userId === stringigiedClient?.userId)
			)
		)
	)

	const chatsQuery = useChatsQuery({
		enabled: false
	})

	const chats = useMemo(() => {
		if (chatsQuery.status !== "success") {
			return []
		}

		return chatsQuery.data.filter(chat => chat.ownerId === stringigiedClient?.userId || chat.lastMessage)
	}, [chatsQuery.status, chatsQuery.data, stringigiedClient?.userId])

	const headerLeftItems = useMemo(() => {
		if (selectedChats.length === 0) {
			return []
		}

		return [
			{
				type: "button",
				icon: {
					name: "close-outline",
					color: textForeground.color,
					size: 20
				},
				props: {
					onPress: () => {
						useChatsStore.getState().setSelectedChats([])
					}
				}
			}
		] satisfies HeaderItem[]
	}, [selectedChats, textForeground.color])

	const headerRightItems = useMemo(() => {
		const items: HeaderItem[] = []
		const menuButtons: MenuButton[] = []

		menuButtons.push({
			id: "selectAll",
			title: selectedChats.length === chats.length ? "tbd_deselect_all" : "tbd_select_all",
			icon: "select",
			onPress: () => {
				if (selectedChats.length === chats.length) {
					useChatsStore.getState().setSelectedChats([])

					return
				}

				useChatsStore.getState().setSelectedChats(chats)
			}
		})

		if (selectedChats.length === 0) {
			menuButtons.push({
				id: "createChat",
				title: "tbd_create_chat",
				icon: "plus",
				onPress: async () => {
					// TODO
				}
			})
		}

		if (selectedChats.length > 0) {
			menuButtons.push({
				id: "bulkMute",
				title: selectedChatsIncludesMuted ? "tbd_unmute_all" : "tbd_mute_all",
				icon: "plus",
				onPress: async () => {
					const result = await runWithLoading(async defer => {
						defer(() => {
							useChatsStore.getState().setSelectedChats([])
						})

						return await Promise.all(
							selectedChats.map(chat =>
								chatsLib.mute({
									chat,
									mute: !selectedChatsIncludesMuted
								})
							)
						)
					})

					if (!result.success) {
						console.error(result.error)
						alerts.error(result.error)

						return
					}
				}
			})

			if (everySelectedChatOwnedBySelf) {
				menuButtons.push({
					id: "bulkDelete",
					title: "tbd_delete_chats",
					icon: "delete",
					destructive: true,
					onPress: async () => {
						const promptResponse = await run(async () => {
							return await prompts.alert({
								title: "tbd_delete_all_chats",
								message: "tbd_delete_all_chats_confirmation",
								cancelText: "tbd_cancel",
								okText: "tbd_delete_all"
							})
						})

						if (!promptResponse.success) {
							console.error(promptResponse.error)
							alerts.error(promptResponse.error)

							return
						}

						if (promptResponse.data.cancelled) {
							useChatsStore.getState().setSelectedChats([])

							return
						}

						const result = await runWithLoading(async defer => {
							defer(() => {
								useChatsStore.getState().setSelectedChats([])
							})

							return await Promise.all(
								selectedChats.map(chat =>
									chatsLib.delete({
										chat
									})
								)
							)
						})

						if (!result.success) {
							console.error(result.error)
							alerts.error(result.error)

							return
						}
					}
				})
			}

			if (selfIsParticipantAndNotOwnerOfEverySelectedChat) {
				menuButtons.push({
					id: "bulkLeave",
					title: "tbd_leave_chats",
					icon: "exit",
					destructive: true,
					onPress: async () => {
						const promptResponse = await run(async () => {
							return await prompts.alert({
								title: "tbd_leave_all_chats",
								message: "tbd_leave_all_chats_confirmation",
								cancelText: "tbd_cancel",
								okText: "tbd_leave_all"
							})
						})

						if (!promptResponse.success) {
							console.error(promptResponse.error)
							alerts.error(promptResponse.error)

							return
						}

						if (promptResponse.data.cancelled) {
							return
						}

						const result = await runWithLoading(async defer => {
							defer(() => {
								useChatsStore.getState().setSelectedChats([])
							})

							return await Promise.all(
								selectedChats.map(chat =>
									chatsLib.leave({
										chat
									})
								)
							)
						})

						if (!result.success) {
							console.error(result.error)
							alerts.error(result.error)

							return
						}
					}
				})
			}
		}

		if (menuButtons.length > 0) {
			items.push({
				type: "menu",
				props: {
					type: "dropdown",
					hitSlop: 20,
					buttons: menuButtons
				},
				triggerProps: {
					hitSlop: 20
				},
				icon: {
					name: "ellipsis-horizontal",
					size: 24,
					color: textForeground.color
				}
			})
		}

		return items
	}, [
		textForeground.color,
		selectedChats,
		selectedChatsIncludesMuted,
		everySelectedChatOwnedBySelf,
		chats,
		selfIsParticipantAndNotOwnerOfEverySelectedChat
	])

	const searchBarOptions = useMemo(() => {
		if (!setSearchQuery) {
			return undefined
		}

		return Platform.select({
			ios: {
				placeholder: "tbd_search_chats",
				onChangeText(e) {
					setSearchQuery(e.nativeEvent.text)
				},
				autoFocus: true,
				autoCapitalize: "none",
				placement: "stacked"
			},
			default: undefined
		}) satisfies SearchBarProps | undefined
	}, [setSearchQuery])

	return (
		<StackHeader
			title="tbd_chats"
			transparent={Platform.OS === "ios"}
			leftItems={headerLeftItems}
			rightItems={headerRightItems}
			searchBarOptions={searchBarOptions}
		/>
	)
})

export const Chats = memo(() => {
	const [searchQuery, setSearchQuery] = useState<string>("")

	useFocusEffect(
		useCallback(() => {
			useChatsStore.getState().setSelectedChats([])

			return () => {
				useChatsStore.getState().setSelectedChats([])
			}
		}, [])
	)

	return (
		<Fragment>
			<Header setSearchQuery={setSearchQuery} />
			<SafeAreaView edges={["left", "right"]}>
				<KeyboardAvoidingView
					className="flex-1 flex-col"
					behavior="padding"
				>
					{Platform.select({
						android: (
							<View className="px-4 pb-4 shrink-0 bg-transparent">
								<TextInput
									className="bg-background-secondary px-4 py-3 rounded-full"
									placeholder="tbd_search_chats"
									onChangeText={setSearchQuery}
									autoCapitalize="none"
									autoCorrect={false}
									spellCheck={false}
									returnKeyType="search"
									autoComplete="off"
									autoFocus={false}
								/>
							</View>
						),
						default: null
					})}

					<List searchQuery={searchQuery} />
				</KeyboardAvoidingView>
			</SafeAreaView>
		</Fragment>
	)
})

export default Chats
