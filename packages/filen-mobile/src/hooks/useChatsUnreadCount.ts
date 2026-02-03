import { useMemo } from "@/lib/memo"
import { useStringifiedClient } from "@/lib/auth"
import useChatsQuery from "@/queries/useChats.query"
import { chatMessagesQueryGet } from "@/queries/useChatMessages.query"
import chats from "@/lib/chats"
import { useEffect, useRef } from "react"
import { runEffect } from "@filen/utils"
import { AppState } from "react-native"

export function useChatsUnreadCount() {
	const didFetchOnStartRef = useRef<boolean>(false)
	const stringifiedClient = useStringifiedClient()

	const chatsQuery = useChatsQuery({
		enabled: false
	})

	const unreadCount = useMemo(() => {
		if (chatsQuery.status !== "success" || !stringifiedClient) {
			return 0
		}

		let unreadCount = 0

		for (const chat of chatsQuery.data) {
			const messages = chatMessagesQueryGet({
				uuid: chat.uuid
			})

			if (!messages) {
				chats.refetchChatsAndMessages().catch(console.error)

				continue
			}

			if (messages.length === 0) {
				continue
			}

			unreadCount += messages.filter(
				message =>
					chat.lastFocus &&
					chat.lastMessage &&
					!chat.muted &&
					message.sentTimestamp > chat.lastFocus &&
					message.inner.senderId !== stringifiedClient?.userId
			).length
		}

		return unreadCount
	}, [chatsQuery.status, chatsQuery.data, stringifiedClient])

	useEffect(() => {
		const { cleanup } = runEffect(defer => {
			const appStateSubscription = AppState.addEventListener("change", nextAppState => {
				if (nextAppState === "active") {
					chats.refetchChatsAndMessages().catch(console.error)
				}
			})

			defer(() => {
				appStateSubscription.remove()
			})
		})

		return () => {
			cleanup()
		}
	}, [])

	useEffect(() => {
		if (!stringifiedClient || didFetchOnStartRef.current) {
			return
		}

		didFetchOnStartRef.current = true

		chats.refetchChatsAndMessages().catch(err => {
			console.error(err)

			didFetchOnStartRef.current = false
		})
	}, [stringifiedClient])

	return unreadCount
}

export default useChatsUnreadCount
