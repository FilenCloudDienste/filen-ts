import { useTranslation } from "react-i18next"
import { MessagesSquareIcon } from "lucide-react"

// The main-card prompt shown when no conversation is selected (bare /chats) or a stale /chats/<uuid> link
// resolves to nothing — mirrors NoteEditorPane's own select/loading prompt. `loading` covers the window
// where the conversation list (which resolves the selected chat) is still in flight.
export function ChatsPlaceholder({ loading = false }: { loading?: boolean }) {
	const { t } = useTranslation("chats")

	return (
		<div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
			<MessagesSquareIcon className="size-8 text-muted-foreground/60" />
			<div className="flex flex-col gap-1">
				<p className="font-heading text-lg font-medium tracking-tight">
					{loading ? t("chatsLoadingThread") : t("chatsSelectPrompt")}
				</p>
				{!loading ? <p className="text-sm text-muted-foreground">{t("chatsSelectPromptDescription")}</p> : null}
			</div>
		</div>
	)
}
