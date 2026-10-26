import type { ReactNode } from "react"
import { useTranslation } from "react-i18next"
import type { DesktopSyncIgnored, DesktopSyncPlanAction, DesktopSyncUnsyncable } from "@filen/shared/desktop"
import { formatBytes } from "@filen/shared"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { EntryRow } from "@/features/desktop/components/entryRow"
import { SettingsBlock } from "@/features/settings/components/settingsLayout"
import type { PagedEntries } from "@/features/sync/hooks/usePagedEntries"
import { ACTION_KIND_KEY } from "@/features/sync/lib/syncStatus.logic"
import { syncErrorLabel } from "@/features/sync/lib/syncActions"
import { UNSYNCABLE_REASON_KEY } from "@/features/sync/lib/syncErrors.logic"

// The rows of the Sync section's path lists (plan lists, issues, ignored paths), built on EntryRow.

export function ActionEntry({ action }: { action: DesktopSyncPlanAction }) {
	const { t } = useTranslation("sync")
	const parts: string[] = [t(ACTION_KIND_KEY[action.kind])]

	if (action.to !== null) {
		parts.push(t("activityMovedTo", { path: action.to }))
	}

	if (action.size !== null && action.node === "file") {
		parts.push(formatBytes(action.size))
	}

	return (
		<EntryRow
			path={action.relPath}
			detail={parts.join(" · ")}
		/>
	)
}

export function UnsyncableEntry({ entry, children }: { entry: DesktopSyncUnsyncable; children?: ReactNode }) {
	const { t } = useTranslation("sync")
	const reason = t(UNSYNCABLE_REASON_KEY[entry.reason])

	return (
		<EntryRow
			path={entry.relPath}
			detail={entry.detail === null ? reason : `${reason} ${entry.detail}`}
		>
			{children}
		</EntryRow>
	)
}

export function IgnoredEntry({ entry }: { entry: DesktopSyncIgnored }) {
	const { t } = useTranslation("sync")
	const source =
		entry.level === "default"
			? t("ignoredLevelDefault")
			: entry.level === "user"
				? t("ignoredLevelUser")
				: entry.dir === null || entry.dir.length === 0
					? t("ignoredLevelFileRoot")
					: t("ignoredLevelFile", { dir: entry.dir })
	const parts: string[] = [entry.pattern, source]

	if (entry.tracked) {
		parts.push(t("ignoredTracked"))
	}

	return (
		<EntryRow
			path={entry.relPath}
			detail={parts.join(" · ")}
		/>
	)
}

// What follows a paged list's rows: its first-page spinner, its error with a retry, or the next page's button.
export function PagedFooter<T>({ paged }: { paged: PagedEntries<T> }) {
	const { t } = useTranslation(["sync", "common"])

	if (paged.error !== null) {
		return (
			<SettingsBlock className="flex flex-wrap items-center justify-between gap-2">
				<p
					role="alert"
					className="text-sm text-destructive"
				>
					{syncErrorLabel(paged.error)}
				</p>
				<Button
					variant="outline"
					size="sm"
					onClick={paged.entries.length === 0 ? paged.reload : paged.loadMore}
				>
					{t("common:tryAgain")}
				</Button>
			</SettingsBlock>
		)
	}

	if (paged.loading && paged.entries.length === 0) {
		return (
			<SettingsBlock className="flex justify-center">
				<Spinner className="size-5 text-muted-foreground" />
			</SettingsBlock>
		)
	}

	if (paged.total === 0) {
		return <SettingsBlock className="text-sm text-muted-foreground">{t("listEmpty")}</SettingsBlock>
	}

	if (!paged.hasMore) {
		return null
	}

	return (
		<SettingsBlock className="flex justify-center py-2.5">
			<Button
				variant="ghost"
				size="sm"
				disabled={paged.loading}
				onClick={paged.loadMore}
			>
				{paged.loading ? <Spinner data-icon="inline-start" /> : null}
				{t("listLoadMore")}
			</Button>
		</SettingsBlock>
	)
}
