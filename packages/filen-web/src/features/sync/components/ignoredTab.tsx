import { useTranslation } from "react-i18next"
import type { DesktopSyncIgnored } from "@filen/shared/desktop"
import { SettingsGroup } from "@/features/settings/components/settingsLayout"
import { usePagedEntries } from "@/features/sync/hooks/usePagedEntries"
import { syncApi } from "@/features/sync/lib/syncStore"
import { IgnoredEntry, PagedFooter } from "@/features/sync/components/syncEntryRows"
import { UserIgnoreEditor } from "@/features/sync/components/userIgnoreEditor"

// The paths this pair skips and the rule behind each, over the device-wide rules the user edits.
export function IgnoredTab({ pairId }: { pairId: string }) {
	const { t } = useTranslation("sync")
	const paged = usePagedEntries<DesktopSyncIgnored>(pairId, (offset, limit) => syncApi().ignoredPaths(pairId, offset, limit))

	return (
		<div className="flex flex-col gap-8">
			<SettingsGroup
				title={t("ignoredTitle")}
				description={t("ignoredDescription")}
			>
				{paged.entries.map(entry => (
					<IgnoredEntry
						key={entry.relPath}
						entry={entry}
					/>
				))}
				<PagedFooter paged={paged} />
			</SettingsGroup>
			<UserIgnoreEditor />
		</div>
	)
}
