import { Fragment, useEffect, useState } from "react"
import { pruneSelection, isOneOnOneWithBlocked } from "@filen/shared"
import SafeAreaView from "@/components/ui/safeAreaView"
import StackHeader, { type HeaderItem } from "@/components/ui/header"
import { Platform } from "react-native"
import List from "@/features/chats/components/list"
import { useShallow } from "zustand/shallow"
import useChatsStore from "@/features/chats/store/useChats.store"
import useChatsQuery from "@/features/chats/queries/useChats.query"
import { useStringifiedClient } from "@/lib/auth"
import useClearSelectionOnFocusChange from "@/hooks/useClearSelectionOnFocusChange"
import chatsLib from "@/features/chats/chats"
import type { MenuButton } from "@/components/ui/menu"
import { selectAllMenuButton } from "@/components/ui/selectAllMenuButton"
import { createChatFlow } from "@/features/chats/chatsActions"
import { runBulk } from "@/lib/bulkOps"
import { aggregateChatSelectionFlags, allVisibleChatsSelected, chatHasUnread, visibleChats } from "@/features/chats/chatSelectors"
import { useTranslation } from "react-i18next"
import { LazyWrapper } from "@/components/lazyWrapper"
import useBlockedUsers from "@/features/contacts/hooks/useBlockedUsers"
import { chatMessagesQueryGet } from "@/features/chats/queries/useChatMessages.query"

const clearSelectedChats = () => useChatsStore.getState().clearSelectedChats()

const Header = ({ setSearchQuery }: { setSearchQuery: React.Dispatch<React.SetStateAction<string>> }) => {
	const { t } = useTranslation()
	const stringigiedClient = useStringifiedClient()
	const selectedChats = useChatsStore(useShallow(state => state.selectedChats))
	const blocked = useBlockedUsers()

	const chatsQuery = useChatsQuery({
		enabled: false
	})

	const chats = (() => {
		// Read the DATA, not the last fetch's verdict: an offline refetch fails and flips `status` to
	// "error" while keeping it (#103).
		if (!chatsQuery.data) {
			return []
		}

		return visibleChats(chatsQuery.data, stringigiedClient?.userId, blocked)
	})()

	// Live-list cross-reference: stale selections could carry old `undecryptable`
	// flags after a refresh. Resolve against `chats` to read the current flag.
	const liveSelectedChats = selectedChats.map(sel => chats.find(live => live.uuid === sel.uuid) ?? sel)
	const chatFlags = aggregateChatSelectionFlags(liveSelectedChats, stringigiedClient?.userId, blocked, uuid =>
		chatMessagesQueryGet({
			uuid
		})
	)

	// Stale-selection purge: if a selected chat becomes a 1:1-with-blocked (e.g. you block its
	// partner while the selection is active) it's hidden from the list, so drop it from the
	// selection too — keeps bulk actions and the select-all toggle honest. Guarded to avoid loops.
	useEffect(() => {
		const kept = pruneSelection(selectedChats, chat => !isOneOnOneWithBlocked(chat, stringigiedClient?.userId, blocked))

		if (kept !== selectedChats) {
			useChatsStore.getState().setSelectedChats(kept)
		}
	}, [selectedChats, blocked, stringigiedClient?.userId])

	const headerLeftItems = (() => {
		if (selectedChats.length === 0) {
			return []
		}

		return [
			{
				type: "clearSelection",
				onPress: () => useChatsStore.getState().clearSelectedChats()
			}
		] satisfies HeaderItem[]
	})()

	const headerRightItems = (() => {
		const items: HeaderItem[] = []
		const menuButtons: MenuButton[] = []

		const allSelected = allVisibleChatsSelected(chats, selectedChats)

		menuButtons.push(
			selectAllMenuButton({
				t,
				allSelected,
				onClear: () => useChatsStore.getState().clearSelectedChats(),
				onSelectAll: () => useChatsStore.getState().selectAllChats(chats)
			})
		)

		if (selectedChats.length === 0) {
			menuButtons.push({
				id: "createChat",
				title: t("create_chat"),
				icon: "plus",
				requiresOnline: true,
				onPress: async () => {
					await createChatFlow()
				}
			})
		}

		if (selectedChats.length > 0) {
			if (chatFlags.includesUnread) {
				const unreadChats = selectedChats.filter(c =>
					chatHasUnread(c, stringigiedClient?.userId ?? 0n, blocked, uuid =>
						chatMessagesQueryGet({
							uuid
						})
					)
				)

				menuButtons.push({
					id: "bulkMarkAsRead",
					requiresOnline: true,
					title: t("mark_as_read"),
					icon: "envelopeOpen",
					onPress: async () => {
						// Only the chats with actual unread go through to avoid no-op SDK calls.
						await runBulk({
							items: unreadChats,
							clearSelection: () => useChatsStore.getState().clearSelectedChats(),
							op: chat => chatsLib.markAsRead({ chat })
						})
					}
				})
			}

			menuButtons.push({
				id: "bulkMute",
				requiresOnline: true,
				title: chatFlags.includesMuted ? t("unmute_all") : t("mute_all"),
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
					title: t("delete_chats"),
					icon: "delete",
					destructive: true,
					onPress: async () => {
						await runBulk({
							items: selectedChats,
							clearSelection: () => useChatsStore.getState().clearSelectedChats(),
							confirm: {
								title: t("delete_all_chats"),
								message: t("delete_all_chats_confirmation"),
								okText: t("delete_all"),
								cancelText: t("cancel"),
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
					title: t("leave_chats"),
					icon: "exit",
					destructive: true,
					onPress: async () => {
						await runBulk({
							items: selectedChats,
							clearSelection: () => useChatsStore.getState().clearSelectedChats(),
							confirm: {
								title: t("leave_all_chats"),
								message: t("leave_all_chats_confirmation"),
								okText: t("leave_all"),
								cancelText: t("cancel"),
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
				type: "ellipsisMenu",
				buttons: menuButtons
			})
		}

		return items
	})()

	return (
		<StackHeader
			title={selectedChats.length > 0 ? t("selected", { count: selectedChats.length }) : t("chats")}
			transparent={Platform.OS === "ios"}
			leftItems={headerLeftItems}
			rightItems={headerRightItems}
			shadowVisible={false}
			search={{
				placeholder: t("search_chats"),
				onChangeText: setSearchQuery
			}}
		/>
	)
}

export const Chats = () => {
	const [searchQuery, setSearchQuery] = useState<string>("")

	useClearSelectionOnFocusChange(clearSelectedChats)

	return (
		<Fragment>
			<Header setSearchQuery={setSearchQuery} />
			<SafeAreaView edges={["left", "right"]}>
				<LazyWrapper>
					<List searchQuery={searchQuery} />
				</LazyWrapper>
			</SafeAreaView>
		</Fragment>
	)
}

export default Chats
