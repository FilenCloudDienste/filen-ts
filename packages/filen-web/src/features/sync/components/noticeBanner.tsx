import { useState } from "react"
import { useTranslation } from "react-i18next"
import type { DesktopSyncHold, DesktopSyncInfoNotice, DesktopSyncNotice, DesktopSyncRootProblem } from "@filen/shared/desktop"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { log } from "@/lib/log"
import { syncApi } from "@/features/sync/lib/syncStore"
import { runSyncAction } from "@/features/sync/lib/syncActions"
import { ROOT_PROBLEM_KEY } from "@/features/sync/lib/syncErrors.logic"
import { HOLD_KEY, INFO_NOTICE_KEY, NOTICE_KEY } from "@/features/sync/lib/syncStatus.logic"
import { DesktopCallout } from "@/features/desktop/components/desktopCallout"

function DismissButton({ label, onDismiss }: { label: string; onDismiss: () => Promise<void> }) {
	return (
		<Button
			variant="outline"
			size="xs"
			onClick={() => {
				onDismiss().catch((error: unknown) => {
					log.warn("sync", "notice could not be dismissed", error)
				})
			}}
		>
			{label}
		</Button>
	)
}

// Why the engine refused a pair, told until dismissed; dismissing it removes the pair.
export function NoticeBanner({
	pairId,
	notices,
	rootProblem
}: {
	pairId: string
	notices: readonly DesktopSyncNotice[]
	rootProblem: DesktopSyncRootProblem | null
}) {
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
						<DismissButton
							label={t("noticeRemove")}
							onDismiss={() => syncApi().dismissNotice(pairId, notice)}
						/>
					}
				>
					{t(NOTICE_KEY[notice])}
					{notice === "refusedLocalRoot" && rootProblem !== null ? ` ${t(ROOT_PROBLEM_KEY[rootProblem])}` : null}
				</DesktopCallout>
			))}
		</div>
	)
}

// What the pair is told once, until dismissed for good.
export function InfoNotices({ pairId, notices }: { pairId: string; notices: readonly DesktopSyncInfoNotice[] }) {
	const { t } = useTranslation("sync")

	return notices.map(notice => (
		<DesktopCallout
			key={notice}
			tone="info"
			action={
				<DismissButton
					label={t("syncNoticeDismiss")}
					onDismiss={() => syncApi().dismissInfo(pairId, notice)}
				/>
			}
		>
			{t(INFO_NOTICE_KEY[notice])}
		</DesktopCallout>
	))
}

// Why a pair moved from the previous app waits for the user, with what it offers: a whole-drive pair starts on
// request, the others are tried again.
export function HoldBanner({ pairId, holds }: { pairId: string; holds: readonly DesktopSyncHold[] }) {
	const { t } = useTranslation("sync")
	const [pending, setPending] = useState(false)

	async function act(action: "retry" | "startAnyway"): Promise<void> {
		setPending(true)
		await runSyncAction(() => syncApi().holdAction(pairId, action))
		setPending(false)
	}

	return holds.map(hold => (
		<DesktopCallout
			key={hold}
			tone="warning"
			action={
				<Button
					variant="outline"
					size="xs"
					disabled={pending}
					onClick={() => {
						void act(hold === "driveRoot" ? "startAnyway" : "retry")
					}}
				>
					{pending ? <Spinner data-icon="inline-start" /> : null}
					{t(hold === "driveRoot" ? "holdStartAnyway" : "holdRetry")}
				</Button>
			}
		>
			{t(HOLD_KEY[hold])}
		</DesktopCallout>
	))
}
