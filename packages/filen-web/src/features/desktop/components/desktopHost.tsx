import { useEffect } from "react"
import { useTranslation } from "react-i18next"
import { useNavigate } from "@tanstack/react-router"
import { contactDisplayName, deriveBlockedUsers, EMPTY_BLOCKED_USERS } from "@filen/shared"
import { registerSocketHandler } from "@/lib/sdk/socket"
import { desktopBridge } from "@/lib/desktop"
import { accountQueryGet } from "@/queries/account"
import { chatsQueryGet } from "@/features/chats/queries/chats"
import { contactsQueryGet } from "@/features/contacts/queries/contacts"
import type { TypedChatSocketEvent } from "@/features/chats/lib/socketHandlers"
import { chatMessageNotification, type NotificationContent } from "@/features/desktop/lib/notifications"
import { loadDesktopPrefs, useDesktopPrefs } from "@/features/desktop/lib/prefs"

// OS notifications only while the user is elsewhere, and only with the pref on. A tag replaces the previous
// notification for the same chat instead of stacking a burst.
function notify(content: NotificationContent, tag: string, open: () => void): void {
	if (useDesktopPrefs.getState().prefs?.notifications !== true || document.hasFocus() || Notification.permission !== "granted") {
		return
	}

	const notification = new Notification(content.title, { body: content.body, tag })

	notification.onclick = () => {
		desktopBridge()?.showWindow()
		open()
	}
}

// Desktop-only duties of the authed shell: notifications for new chat messages and contact requests, which come
// from this page's socket (main has none yet, so the shell keeps a hidden window's page alive while they are on).
// Mounted by appShell only with the desktop bridge. Renders nothing.
export function DesktopHost(): null {
	const { t } = useTranslation(["chats", "contacts", "common"])
	const navigate = useNavigate()

	useEffect(() => {
		void loadDesktopPrefs()

		// The shell grants it without asking; "default" only means nothing asked yet.
		if (Notification.permission === "default") {
			void Notification.requestPermission()
		}
	}, [])

	useEffect(() => {
		const unregisterChat = registerSocketHandler("chat", (event: TypedChatSocketEvent) => {
			if (event.inner.type !== "messageNew") {
				return
			}

			const message = event.inner.msg
			const blocked = contactsQueryGet()?.blocked
			const content = chatMessageNotification(
				message,
				chatsQueryGet()?.find(chat => chat.uuid === message.chat),
				accountQueryGet()?.id,
				blocked === undefined || blocked.length === 0 ? EMPTY_BLOCKED_USERS : deriveBlockedUsers(blocked),
				{
					undecryptableChat: t("chats:chatUndecryptable"),
					soloFallback: t("chats:chatJustYou"),
					undecryptableMessage: t("chats:chatMessageUndecryptable")
				}
			)

			if (content !== null) {
				notify(content, message.chat, () => {
					void navigate({ to: "/chats/$uuid", params: { uuid: message.chat } })
				})
			}
		})

		const unregisterContact = registerSocketHandler("contact", event => {
			notify(
				{
					title: t("contacts:contactsRequestNotificationTitle"),
					body: contactDisplayName({ email: event.inner.senderEmail, nickName: event.inner.senderNickName })
				},
				`contact-request-${event.inner.uuid}`,
				() => {
					void navigate({ to: "/contacts", search: { section: "requests" } })
				}
			)
		})

		return () => {
			unregisterChat()
			unregisterContact()
		}
	}, [navigate, t])

	return null
}
