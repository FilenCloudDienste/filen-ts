import { useTranslation } from "react-i18next"
import { EyeOffIcon, TagIcon } from "lucide-react"
import { useIsOnline } from "@/lib/useIsOnline"
import type { CorrectionKind } from "@/features/videos/lib/corrections.logic"
import { SetAsEntries } from "@/features/videos/components/setAsMenu"
import { BulkActionButton, BulkActionMenuButton, SelectionActionBar } from "@/components/selectionActionBar"

// A library grid's floating selection bar (the drive's pill): Set as and Hide for every selected title, each one
// write of the library configuration.
export function VideosBulkBar({
	count,
	busy,
	onSetAs,
	onHide,
	onClear
}: {
	count: number
	// A bulk change is being read or saved.
	busy: boolean
	onSetAs: (kind: CorrectionKind) => void
	onHide: () => void
	onClear: () => void
}) {
	const { t } = useTranslation(["videos", "common"])
	const isOnline = useIsOnline()
	const disabled = busy || !isOnline
	const disabledReason = isOnline ? undefined : t("common:offlineActionDisabled")

	return (
		<SelectionActionBar
			count={count}
			clearKbdAction="videos.clearSelection"
			onClear={onClear}
		>
			<BulkActionMenuButton
				icon={TagIcon}
				label={t("setAsMenu")}
				disabled={disabled}
				disabledReason={disabledReason}
			>
				<SetAsEntries
					current={null}
					onSetAs={onSetAs}
				/>
			</BulkActionMenuButton>
			<BulkActionButton
				icon={EyeOffIcon}
				label={t("setAsHideSelected")}
				disabled={disabled}
				disabledReason={disabledReason}
				onClick={onHide}
			/>
		</SelectionActionBar>
	)
}
