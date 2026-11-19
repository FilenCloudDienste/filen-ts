import { useTranslation } from "react-i18next"
import { WifiOffIcon } from "lucide-react"
import { cn } from "@filen/shared"
import { useSocketStatusStore } from "@/features/chats/store/useSocketStatus"

// The chat-surface disconnect strip — a thin banner pinned above the chat content while the
// realtime socket is reconnecting. Driven purely by the socket-status store (set from the chat socket
// handlers' reconnecting/authSuccess events), so it reflects the live connection regardless of which
// chat, if any, is open.
//
// The role=status container is rendered unconditionally with only its content toggled: a live region must
// already be in the a11y tree when its content changes, so an already-populated one inserted on demand is
// commonly missed by screen readers. While connected it is empty, unpadded and unstyled, so zero-height.
export function ChatConnectionBanner() {
	const { t } = useTranslation("chats")
	const reconnecting = useSocketStatusStore(state => state.status) !== "connected"

	return (
		<div
			role="status"
			className={cn(
				"shrink-0",
				reconnecting &&
					"flex items-center justify-center gap-2 bg-warning/15 px-4 py-1.5 text-xs font-medium text-warning-foreground"
			)}
		>
			{reconnecting ? (
				<>
					<WifiOffIcon
						aria-hidden="true"
						className="size-3.5"
					/>
					{t("chatReconnecting")}
				</>
			) : null}
		</div>
	)
}
