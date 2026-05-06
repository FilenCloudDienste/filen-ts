import { Fragment, memo, useCallback, useState } from "react"
import SafeAreaView from "@/components/ui/safeAreaView"
import StackHeader, { type HeaderItem } from "@/components/ui/header"
import { Platform } from "react-native"
import List from "@/components/chats/list"
import { useShallow } from "zustand/shallow"
import useChatsStore from "@/stores/useChats.store"
import useChatsQuery from "@/queries/useChats.query"
import { useStringifiedClient } from "@/lib/auth"
import { useFocusEffect, router } from "expo-router"
import { useResolveClassNames } from "uniwind"
import chatsLib from "@/lib/chats"
import { runWithLoading } from "@/components/ui/fullScreenLoadingModal"
import alerts from "@/lib/alerts"
import { run } from "@filen/utils"
import prompts from "@/lib/prompts"
import type { MenuButton } from "@/components/ui/menu"
import { selectContacts } from "@/routes/contacts"

const Header = memo(({ setSearchQuery }: { setSearchQuery: React.Dispatch<React.SetStateAction<string>> }) => {
	const stringigiedClient = useStringifiedClient()
	const selectedChats = useChatsStore(useShallow(state => state.selectedChats))
	const textForeground = useResolveClassNames("text-foreground")
	const textMutedForeground = useResolveClassNames("text-muted-foreground")
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

	const chats = (() => {
		if (chatsQuery.status !== "success") {
			return []
		}

		return chatsQuery.data.filter(chat => chat.ownerId === stringigiedClient?.userId || chat.lastMessage)
	})()

	const headerLeftItems = (() => {
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
	})()

	const headerRightItems = (() => {
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
					const selectContactsResult = await selectContacts({
						multiple: true,
						userIdsToExclude: []
					})

					if (selectContactsResult.cancelled) {
						return
					}

					const result = await runWithLoading(async () => {
						return await chatsLib.create({
							contacts: selectContactsResult.selectedContacts
						})
					})

					if (!result.success) {
						console.error(result.error)
						alerts.error(result.error)

						return
					}

					router.push(`/chat/${result.data.uuid}`)
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
	})()

	return (
		<StackHeader
			title="tbd_chats"
			transparent={Platform.OS === "ios"}
			leftItems={headerLeftItems}
			rightItems={headerRightItems}
			searchBarOptions={{
				placement: "integratedButton",
				placeholder: "tbd_search_chats",
				onChangeText: e => setSearchQuery(e.nativeEvent.text),
				onCancelButtonPress: () => setSearchQuery(""),
				onClose: () => setSearchQuery(""),
				onOpen: () => setSearchQuery(""),
				allowToolbarIntegration: false,
				headerIconColor: textForeground.color,
				textColor: textForeground.color,
				barTintColor: "transparent",
				tintColor: textForeground.color,
				hintTextColor: textMutedForeground.color,
				shouldShowHintSearchIcon: true,
				hideNavigationBar: false,
				hideWhenScrolling: false,
				inputType: "text"
			}}
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
				<List searchQuery={searchQuery} />
			</SafeAreaView>
		</Fragment>
	)
})

export default Chats
