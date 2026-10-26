import { useTranslation } from "react-i18next"
import type { DesktopSyncNotice } from "@filen/shared/desktop"
import { Button } from "@/components/ui/button"
import { log } from "@/lib/log"
import { syncApi } from "@/features/sync/lib/syncStore"
import { NOTICE_KEY, NOTICE_ROLE } from "@/features/sync/lib/syncStatus.logic"
import { SyncCallout } from "@/features/sync/components/syncCallout"

// What the shell tells once per pair until dismissed. Dismissing drops it from the next overview; dismissing a refusal
// removes the pair it is about.
export function NoticeBanner({ pairId, notices }: { pairId: string; notices: readonly DesktopSyncNotice[] }) {
	const { t } = useTranslation("sync")

	if (notices.length === 0) {
		return null
	}

	return (
		<div className="flex flex-col gap-2">
			{notices.map(notice => (
				<SyncCallout
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
							{t(NOTICE_ROLE[notice] === "refused" ? "noticeRemove" : "noticeDismiss")}
						</Button>
					}
				>
					{t(NOTICE_KEY[notice])}
				</SyncCallout>
			))}
		</div>
	)
}
