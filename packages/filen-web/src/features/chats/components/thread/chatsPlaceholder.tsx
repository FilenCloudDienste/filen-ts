import { useTranslation } from "react-i18next"
import { MessagesSquareIcon } from "lucide-react"
import { EmptyMessage } from "@/components/emptyMessage"

// The main-card prompt shown when no conversation is selected (bare /chats) or a stale /chats/<uuid> link
// resolves to nothing — mirrors NoteEditorPane's own select/loading prompt. `loading` covers the window
// where the conversation list (which resolves the selected chat) is still in flight.
export function ChatsPlaceholder({ loading: loadingProp }: { loading?: boolean }) {
	// Not a destructuring default, which the React Compiler cannot lower.
	const loading = loadingProp ?? false
	const { t } = useTranslation("chats")

	return (
		<EmptyMessage
			icon={MessagesSquareIcon}
			title={loading ? t("chatsLoadingThread") : t("chatsSelectPrompt")}
			description={loading ? undefined : t("chatsSelectPromptDescription")}
		/>
	)
}
