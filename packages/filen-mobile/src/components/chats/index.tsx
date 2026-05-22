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
import type { MenuButton } from "@/components/ui/menu"
import { selectContacts } from "@/routes/contacts"
import { runBulk } from "@/lib/bulkOps"
import { aggregateChatSelectionFlags, chatHasUnread } from "@/lib/chatSelectors"

const Header = memo(({ setSearchQuery }: { setSearchQuery: React.Dispatch<React.SetStateAction<string>> }) => {
	const stringigiedClient = useStringifiedClient()
	const selectedChats = useChatsStore(useShallow(state => state.selectedChats))
	const textForeground = useResolveClassNames("text-foreground")
	const textMutedForeground = useResolveClassNames("text-muted-foreground")
	const chatFlags = aggregateChatSelectionFlags(selectedChats, stringigiedClient?.userId)

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
						useChatsStore.getState().clearSelectedChats()
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
					useChatsStore.getState().clearSelectedChats()

					return
				}

				useChatsStore.getState().selectAllChats(chats)
			}
		})

		if (selectedChats.length === 0) {
			menuButtons.push({
				id: "createChat",
				title: "tbd_create_chat",
				icon: "plus",
				requiresOnline: true,
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
			if (chatFlags.includesUnread) {
				const unreadChats = selectedChats.filter(c => chatHasUnread(c, stringigiedClient?.userId ?? 0n))

				menuButtons.push({
					id: "bulkMarkAsRead",
					requiresOnline: true,
					title: "tbd_mark_as_read",
					icon: "envelopeOpen",
					onPress: async () => {
						// Mirror the single-item path in chats/list/chat/menu.tsx — call
						// both markRead AND updateLastFocusTimesNow per chat. Only the
						// chats with actual unread go through to avoid no-op SDK calls.
						await runBulk({
							items: unreadChats,
							clearSelection: () => useChatsStore.getState().clearSelectedChats(),
							op: async chat => {
								await Promise.all([chatsLib.markRead({ chat }), chatsLib.updateLastFocusTimesNow({ chats: [chat] })])
							}
						})
					}
				})
			}

			menuButtons.push({
				id: "bulkMute",
				requiresOnline: true,
				title: chatFlags.includesMuted ? "tbd_unmute_all" : "tbd_mute_all",
				icon: "mute",
				onPress: async () => {
					await runBulk({
						items: selectedChats,
						clearSelection: () => useChatsStore.getState().clearSelectedChats(),
						op: chat => chatsLib.mute({ chat, mute: !chatFlags.includesMuted })
					})
				}
			})

			if (chatFlags.everyOwnedBySelf) {
				menuButtons.push({
					id: "bulkDelete",
					requiresOnline: true,
					title: "tbd_delete_chats",
					icon: "delete",
					destructive: true,
					onPress: async () => {
						await runBulk({
							items: selectedChats,
							clearSelection: () => useChatsStore.getState().clearSelectedChats(),
							confirm: {
								title: "tbd_delete_all_chats",
								message: "tbd_delete_all_chats_confirmation",
								okText: "tbd_delete_all",
								cancelText: "tbd_cancel",
								destructive: true
							},
							op: chat => chatsLib.delete({ chat })
						})
					}
				})
			}

			if (chatFlags.selfIsParticipantNotOwnerOfEvery) {
				menuButtons.push({
					id: "bulkLeave",
					requiresOnline: true,
					title: "tbd_leave_chats",
					icon: "exit",
					destructive: true,
					onPress: async () => {
						await runBulk({
							items: selectedChats,
							clearSelection: () => useChatsStore.getState().clearSelectedChats(),
							confirm: {
								title: "tbd_leave_all_chats",
								message: "tbd_leave_all_chats_confirmation",
								okText: "tbd_leave_all",
								cancelText: "tbd_cancel",
								destructive: true
							},
							op: chat => chatsLib.leave({ chat })
						})
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
			title={selectedChats.length > 0 ? `${selectedChats.length} tbd_selected` : "tbd_chats"}
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
			useChatsStore.getState().clearSelectedChats()

			return () => {
				useChatsStore.getState().clearSelectedChats()
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
