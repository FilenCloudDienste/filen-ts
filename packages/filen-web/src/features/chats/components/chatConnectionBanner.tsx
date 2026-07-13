import { useTranslation } from "react-i18next"
import { WifiOffIcon } from "lucide-react"
import { useSocketStatusStore } from "@/features/chats/store/useSocketStatus"

// The chat-surface disconnect strip — a thin banner pinned above the chat content while the
// realtime socket is reconnecting. Driven purely by the socket-status store (set from the chat socket
// handlers' reconnecting/authSuccess events), so it reflects the live connection regardless of which
// chat, if any, is open. Renders nothing while connected.
export function ChatConnectionBanner() {
	const { t } = useTranslation("chats")
	const status = useSocketStatusStore(state => state.status)

	if (status === "connected") {
		return null
	}

	return (
		<div
			role="status"
			className="flex shrink-0 items-center justify-center gap-2 bg-amber-500/15 px-4 py-1.5 text-xs font-medium text-amber-700 dark:text-amber-400"
		>
			<WifiOffIcon
				aria-hidden="true"
				className="size-3.5"
			/>
			{t("chatReconnecting")}
		</div>
	)
}
