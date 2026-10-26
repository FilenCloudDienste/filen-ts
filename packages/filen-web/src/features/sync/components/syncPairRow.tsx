import { useTranslation } from "react-i18next"
import { Link } from "@tanstack/react-router"
import { ArrowLeftRightIcon } from "lucide-react"
import { useShallow } from "zustand/shallow"
import { cn } from "@filen/shared"
import { useSyncStore } from "@/features/sync/lib/syncStore"
import { issueTotal, pathBasename, PHASE_KEY } from "@/features/sync/lib/syncStatus.logic"
import { useRemoteDirectoryName } from "@/features/sync/hooks/useRemoteDirectoryName"
import { SyncPhaseIcon } from "@/features/sync/components/syncPhaseIcon"

// One pair in the sidebar: its name and phase over its two directories. Selects only what it draws, so a pass's
// progress pushes re-render none of the rows.
export function SyncPairRow({ pairId, selected }: { pairId: string; selected: boolean }) {
	const { t } = useTranslation("sync")
	const row = useSyncStore(
		useShallow(state => {
			const pair = state.overview?.pairs.find(candidate => candidate.id === pairId)

			return pair === undefined
				? null
				: {
						name: pair.name,
						phase: pair.phase,
						localRoot: pair.localRoot,
						remoteRoot: pair.remoteRoot,
						issues: issueTotal(pair.issues)
					}
		})
	)
	const remoteName = useRemoteDirectoryName(row?.remoteRoot ?? "")

	if (row === null) {
		return null
	}

	const localName = pathBasename(row.localRoot)

	return (
		<li>
			<Link
				to="/sync/$pairId"
				params={{ pairId }}
				aria-current={selected ? "page" : undefined}
				className={cn(
					"flex w-full items-start gap-2.5 rounded-xl px-2.5 py-2 text-left focus-ring-row transition-colors outline-none app-region-no-drag",
					selected ? "bg-sidebar-accent text-sidebar-accent-foreground" : "hover:bg-sidebar-accent/60"
				)}
			>
				<SyncPhaseIcon
					phase={row.phase}
					hasIssues={row.issues > 0}
					className="mt-0.5"
				/>
				<div className="flex min-w-0 flex-1 flex-col gap-0.5">
					<span className="truncate text-sm font-medium">
						{row.name}
						<span className="sr-only">, {t(PHASE_KEY[row.phase])}</span>
					</span>
					<span
						title={row.localRoot}
						className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground"
					>
						<span className="min-w-0 truncate">{localName}</span>
						<ArrowLeftRightIcon
							aria-hidden="true"
							className="size-3 shrink-0"
						/>
						<span className="min-w-0 truncate">{remoteName ?? "…"}</span>
					</span>
				</div>
			</Link>
		</li>
	)
}
