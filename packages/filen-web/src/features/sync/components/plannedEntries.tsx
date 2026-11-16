import { useEffect, type ReactNode } from "react"
import { useTranslation } from "react-i18next"
import type { DesktopSyncPlanList, DesktopSyncPlanPage } from "@filen/shared/desktop"
import { Spinner } from "@/components/ui/spinner"
import { log } from "@/lib/log"
import { SettingsBlock } from "@/features/settings/components/settingsLayout"
import { type PagedEntries, usePagedEntries } from "@/features/sync/hooks/usePagedEntries"
import { useSyncRead } from "@/features/sync/hooks/useSyncRead"
import { syncApi } from "@/features/sync/lib/syncStore"
import { syncErrorLabel } from "@/features/sync/lib/syncActions"

// Before this run saw a pass of the pair, only a dry run lists what its report would: planned once while the list
// shows, and released again. `pick` takes the entries of `list` from a page of it; `children` renders them, keyed by
// the plan read.
export function PlannedEntries<T>({
	pairId,
	readKey,
	list,
	pick,
	children
}: {
	pairId: string
	readKey: string
	list: DesktopSyncPlanList
	pick: (page: DesktopSyncPlanPage) => T[]
	children: (paged: PagedEntries<T>, planId: string) => ReactNode
}) {
	const { t } = useTranslation("sync")
	const planRead = useSyncRead(readKey, () => syncApi().plan(pairId))
	const planId = planRead.data?.planId ?? null
	const paged = usePagedEntries<T>(planId, async (offset, limit) => {
		const result = await syncApi().planPage(planId ?? "", list, offset, limit)

		if (!result.ok) {
			return result
		}

		return { ok: true, value: { total: result.value.total, entries: pick(result.value) } }
	})

	useEffect(() => {
		if (planId === null) {
			return
		}

		return () => {
			syncApi()
				.releasePlan(planId)
				.catch((error: unknown) => {
					log.warn("sync", "plan could not be released", error)
				})
		}
	}, [planId])

	if (planRead.error !== null) {
		return (
			<SettingsBlock>
				<p
					role="alert"
					className="text-sm text-destructive"
				>
					{syncErrorLabel(planRead.error)}
				</p>
			</SettingsBlock>
		)
	}

	if (planRead.data === null) {
		// The cloud side has not caught up, so there is no dry run to list them from yet.
		return <SettingsBlock className="text-sm text-muted-foreground">{t("reviewUnconverged")}</SettingsBlock>
	}

	if (planRead.data === undefined) {
		return (
			<SettingsBlock className="flex justify-center">
				<Spinner className="size-5 text-muted-foreground" />
			</SettingsBlock>
		)
	}

	return children(paged, planRead.data.planId)
}
