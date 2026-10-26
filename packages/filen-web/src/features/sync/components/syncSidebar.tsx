import { useTranslation } from "react-i18next"
import { useRouterState } from "@tanstack/react-router"
import { FolderSyncIcon, PlusIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { LoadingState } from "@/components/loadingState"
import { SidebarNotice } from "@/components/sidebarNotice"
import { ResizableSidebarPanel } from "@/features/shell/components/sidebarPanel"
import { openAddPair, syncApi, useSyncHost, useSyncPairIds } from "@/features/sync/lib/syncStore"
import { hostBanner } from "@/features/sync/lib/syncStatus.logic"
import { SyncPairRow } from "@/features/sync/components/syncPairRow"
import { SyncCallout } from "@/features/sync/components/syncCallout"

const PAIR_PATH = /^\/sync\/([^/]+)/

// What the native sync host is doing when that is worth telling: starting, restarting, or failed with a retry.
function HostBanner() {
	const { t } = useTranslation("sync")
	const host = useSyncHost()
	const banner = host === null ? null : hostBanner(host)

	if (banner === null) {
		return null
	}

	return (
		<SyncCallout
			tone={banner.tone}
			className="app-region-no-drag"
			action={
				banner.retry ? (
					<Button
						variant="outline"
						size="xs"
						onClick={() => {
							syncApi().retryHost()
						}}
					>
						{t("hostRetry")}
					</Button>
				) : undefined
			}
		>
			{t(banner.key)}
		</SyncCallout>
	)
}

// The Sync section's contextual sidebar: the host's state over the list of pairs, and the add-pair entry point.
export function SyncSidebar() {
	const { t } = useTranslation(["sync", "common"])
	const pairIds = useSyncPairIds()
	const selectedId = useRouterState({ select: state => PAIR_PATH.exec(state.location.pathname)?.[1] ?? null })

	return (
		<ResizableSidebarPanel
			module="sync"
			resizeLabel={t("syncSidebarResize")}
		>
			<div className="flex flex-col gap-2 p-3">
				<div className="flex items-center justify-between gap-2">
					<h2 className="truncate px-1 text-[15px] font-semibold">{t("common:moduleSync")}</h2>
					<Button
						variant="ghost"
						size="icon-sm"
						aria-label={t("syncAddPair")}
						title={t("syncAddPair")}
						className="app-region-no-drag"
						onClick={openAddPair}
					>
						<PlusIcon />
					</Button>
				</div>
				<HostBanner />
			</div>
			<div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-1.5 pb-3">
				{pairIds === null ? (
					<LoadingState size="md" />
				) : pairIds.length === 0 ? (
					<SidebarNotice
						icon={<FolderSyncIcon />}
						title={t("syncEmptyTitle")}
						description={t("syncEmptyDescription")}
						action={
							<Button
								variant="outline"
								size="sm"
								className="mt-1 app-region-no-drag"
								onClick={openAddPair}
							>
								<PlusIcon />
								{t("syncAddPair")}
							</Button>
						}
					/>
				) : (
					<ul
						aria-label={t("syncListLabel")}
						className="flex flex-col gap-0.5"
					>
						{pairIds.map(pairId => (
							<SyncPairRow
								key={pairId}
								pairId={pairId}
								selected={pairId === selectedId}
							/>
						))}
					</ul>
				)}
			</div>
		</ResizableSidebarPanel>
	)
}
