import { useTranslation } from "react-i18next"
import type { DesktopSyncNotice } from "@filen/shared/desktop"
import { Button } from "@/components/ui/button"
import { log } from "@/lib/log"
import { syncApi } from "@/features/sync/lib/syncStore"
import { NOTICE_KEY } from "@/features/sync/lib/syncStatus.logic"
import { DesktopCallout } from "@/features/desktop/components/desktopCallout"

// Why the engine refused a pair, told until dismissed; dismissing it removes the pair.
export function NoticeBanner({ pairId, notices }: { pairId: string; notices: readonly DesktopSyncNotice[] }) {
	const { t } = useTranslation("sync")

	if (notices.length === 0) {
		return null
	}

	return (
		<div className="flex flex-col gap-2">
			{notices.map(notice => (
				<DesktopCallout
					key={notice}
					tone="info"
					action={
						<Button
							variant="outline"
							size="xs"
							onClick={() => {
								syncApi()
									.dismissNotice(pairId, notice)
									.catch((error: unknown) => {
										log.warn("sync", "notice could not be dismissed", error)
									})
							}}
						>
							{t("noticeRemove")}
						</Button>
					}
				>
					{t(NOTICE_KEY[notice])}
				</DesktopCallout>
			))}
		</div>
	)
}
