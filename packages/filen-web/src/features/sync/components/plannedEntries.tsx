import { useEffect, useRef, type ReactNode } from "react"
import { useTranslation } from "react-i18next"
import type { DesktopSyncPlan, DesktopSyncPlanList, DesktopSyncPlanPage, DesktopSyncResult } from "@filen/shared/desktop"
import { Spinner } from "@/components/ui/spinner"
import { log } from "@/lib/log"
import { SettingsBlock } from "@/features/settings/components/settingsLayout"
import { type PagedEntries, usePagedEntries } from "@/features/sync/hooks/usePagedEntries"
import { useSyncRead } from "@/features/sync/hooks/useSyncRead"
import { syncApi } from "@/features/sync/lib/syncStore"
import { SyncReadError } from "@/features/sync/components/syncEntryRows"

function releasePlan(planId: string): void {
	syncApi()
		.releasePlan(planId)
		.catch((error: unknown) => {
			log.warn("sync", "plan could not be released", error)
		})
}

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
	// The key the list shows now, null once it is gone: a dry run answering for an older key, or after unmount, is
	// dropped by useSyncRead, so it is released here instead of held until the shell's expiry.
	const liveKeyRef = useRef<string | null>(null)
	const planRead = useSyncRead(readKey, async (): Promise<DesktopSyncResult<DesktopSyncPlan | null>> => {
		const startedKey = readKey
		const result = await syncApi().plan(pairId)

		if (result.ok && result.value !== null && liveKeyRef.current !== startedKey) {
			releasePlan(result.value.planId)

			return { ok: true, value: null }
		}

		return result
	})
	const planId = planRead.data?.planId ?? null
	const listed = usePagedEntries<T>(planId, async (offset, limit) => {
		const result = await syncApi().planPage(planId ?? "", list, offset, limit)

		if (!result.ok) {
			return result
		}

		return { ok: true, value: { total: result.value.total, entries: pick(result.value) } }
	})
	// The shell releases a dry run minutes after its last read (planExpired) and never reads it again: whatever renders
	// this list's footer retries by planning again (from the click, never on its own, so a failing host cannot loop),
	// and the list then pages the new plan (the old id is released below).
	const paged: PagedEntries<T> =
		listed.error?.code === "planExpired" ? { ...listed, reload: planRead.reload, loadMore: planRead.reload } : listed

	useEffect(() => {
		// Set again on setup: StrictMode's mount-cleanup-mount must not count the list as gone.
		liveKeyRef.current = readKey

		return () => {
			liveKeyRef.current = null
		}
	}, [readKey])

	useEffect(() => {
		if (planId === null) {
			return
		}

		return () => {
			releasePlan(planId)
		}
	}, [planId])

	if (planRead.error !== null) {
		return (
			<SyncReadError
				error={planRead.error}
				onRetry={planRead.reload}
			/>
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
