import { useEffect } from "react"
import { useTranslation } from "react-i18next"
import { useNavigate } from "@tanstack/react-router"
import { toast } from "sonner"
import { contactDisplayName, deriveBlockedUsers, EMPTY_BLOCKED_USERS } from "@filen/shared"
import { registerSocketHandler } from "@/lib/sdk/socket"
import { desktopBridge } from "@/lib/desktop"
import { accountQueryGet } from "@/queries/account"
import { chatsQueryGet } from "@/features/chats/queries/chats"
import { contactsQueryGet } from "@/features/contacts/queries/contacts"
import type { TypedChatSocketEvent } from "@/features/chats/lib/socketHandlers"
import { chatMessageNotification, type NotificationContent } from "@/features/desktop/lib/notifications"
import { loadDesktopPrefs, useDesktopPrefs } from "@/features/desktop/lib/prefs"
import { isDesktopLocked } from "@/features/desktop/lib/lock"
import { i18n } from "@/lib/i18n"

// One prompt however often main reports the same download (each page load hears it again).
const UPDATE_TOAST_ID = "desktop-update"

// OS notifications only while the user is elsewhere, only with the pref on, and never while the app is locked (they
// would show message text the lock hides). A tag replaces the previous
// notification for the same chat instead of stacking a burst.
function notify(content: NotificationContent, tag: string, open: () => void): void {
	if (
		useDesktopPrefs.getState().prefs?.notifications !== true ||
		document.hasFocus() ||
		Notification.permission !== "granted" ||
		isDesktopLocked()
	) {
		return
	}

	const notification = new Notification(content.title, { body: content.body, tag })

	notification.onclick = () => {
		desktopBridge()?.showWindow()
		open()
	}
}

// Desktop-only duties of the authed shell: notifications for new chat messages and contact requests, which come
// from this page's socket (main has none yet, so the shell keeps a hidden window's page alive while they are on),
// and the prompt to restart into a downloaded update. Mounted by appShell only with the desktop bridge. Renders
// nothing.
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
		const bridge = desktopBridge()

		return bridge?.app.onUpdateReady(version => {
			toast(i18n.t("desktop:updateReadyTitle"), {
				id: UPDATE_TOAST_ID,
				description: i18n.t("desktop:updateReadyBody", { version }),
				duration: Infinity,
				action: {
					label: i18n.t("desktop:updateRestart"),
					onClick: () => {
						bridge.app.installUpdate()
					}
				}
			})
		})
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
