import { useTranslation } from "react-i18next"
import { FolderSyncIcon } from "lucide-react"
import { EmptyMessage } from "@/components/emptyMessage"
import { LoadingState } from "@/components/loadingState"
import { useSyncPairIds } from "@/features/sync/lib/syncStore"

// The content card when no pair is shown: loading until the first overview, then the select prompt, or
// (`missing`) a pair id that no longer exists. With no pairs the sidebar alone carries the empty state and
// its add entry point, as in Notes and Chats.
export function SyncPlaceholder({ missing }: { missing?: boolean }) {
	const { t } = useTranslation("sync")
	const pairIds = useSyncPairIds()

	if (pairIds === null) {
		return <LoadingState size="lg" />
	}

	return (
		<EmptyMessage
			icon={FolderSyncIcon}
			title={missing === true ? t("detailMissingTitle") : t("detailSelectPrompt")}
			description={t("detailSelectPromptDescription")}
		/>
	)
}
