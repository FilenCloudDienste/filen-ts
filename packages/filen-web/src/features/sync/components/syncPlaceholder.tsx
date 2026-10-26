import { useTranslation } from "react-i18next"
import { FolderSyncIcon, PlusIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { EmptyMessage } from "@/components/emptyMessage"
import { LoadingState } from "@/components/loadingState"
import { openAddPair, useSyncPairIds } from "@/features/sync/lib/syncStore"

// The content card when no pair is shown: loading until the first overview, the add prompt without pairs, the
// select prompt otherwise, or (`missing`) a pair id that no longer exists.
export function SyncPlaceholder({ missing }: { missing?: boolean }) {
	const { t } = useTranslation("sync")
	const pairIds = useSyncPairIds()

	if (pairIds === null) {
		return <LoadingState size="lg" />
	}

	if (pairIds.length === 0) {
		return (
			<EmptyMessage
				icon={FolderSyncIcon}
				title={t("syncEmptyTitle")}
				description={t("syncEmptyDescription")}
			>
				<Button onClick={openAddPair}>
					<PlusIcon />
					{t("syncAddPair")}
				</Button>
			</EmptyMessage>
		)
	}

	return (
		<EmptyMessage
			icon={FolderSyncIcon}
			title={missing === true ? t("detailMissingTitle") : t("detailSelectPrompt")}
			description={t("detailSelectPromptDescription")}
		/>
	)
}
