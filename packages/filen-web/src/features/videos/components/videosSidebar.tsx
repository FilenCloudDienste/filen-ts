import type { ComponentType, ReactNode } from "react"
import { useTranslation } from "react-i18next"
import { Link } from "@tanstack/react-router"
import {
	BoxIcon,
	FilmIcon,
	FolderClosedIcon,
	FolderPlusIcon,
	HouseIcon,
	PlusIcon,
	Settings2Icon,
	TriangleAlertIcon,
	TvIcon
} from "lucide-react"
import { cn } from "@filen/shared"
import { ResizableSidebarPanel } from "@/features/shell/components/sidebarPanel"
import { GROUP_HEADER_CLASS, SIDEBAR_NAV_ITEM_CLASS } from "@/features/shell/lib/sidebarNavItem"
import { useVideoLibraryView, useVideoRootName } from "@/features/videos/hooks/useVideoLibraryView"
import { isRootBusy, type VideoLibraryRootView } from "@/features/videos/lib/libraryView.logic"
import { openVideosChooser, setVideosLibrariesOpen } from "@/features/videos/store/useVideosDialogStore"
import { useIsOnline } from "@/lib/useIsOnline"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import { Spinner } from "@/components/ui/spinner"

type IconType = ComponentType<{ className?: string }>

const COUNT_CLASS = "ml-auto shrink-0 pl-2 text-xs text-muted-foreground tabular-nums"

// A count on the right of a row: the number for the eye, its long form for a screen reader.
function RowCount({ count, label }: { count: number; label: string }) {
	const { i18n } = useTranslation()

	return (
		<>
			<span
				aria-hidden="true"
				className={COUNT_CLASS}
			>
				{count.toLocaleString(i18n.language)}
			</span>
			<span className="sr-only">{label}</span>
		</>
	)
}

function NavRow({
	to,
	icon: Icon,
	label,
	exact,
	dimmed,
	children
}: {
	to: "/videos" | "/videos/movies" | "/videos/shows" | "/videos/other"
	icon: IconType
	label: string
	exact?: boolean
	dimmed?: boolean
	children?: ReactNode
}) {
	return (
		<Link
			to={to}
			activeOptions={{ exact: exact === true }}
			className={cn(SIDEBAR_NAV_ITEM_CLASS, dimmed === true && "text-muted-foreground data-[status=active]:text-muted-foreground")}
		>
			<Icon className="text-muted-foreground group-data-[status=active]:text-primary" />
			<span className="truncate">{label}</span>
			{children}
		</Link>
	)
}

// A library directory: its count, or a spinner or a warning in the count's place.
function RootRow({ root }: { root: VideoLibraryRootView }) {
	const { t } = useTranslation("videos")
	const name = useVideoRootName(root.uuid, root)
	const busy = isRootBusy(root.phase)
	const warn = root.phase === "incomplete" || root.phase === "missing"

	return (
		<Link
			to="/videos/library/$uuid"
			params={{ uuid: root.uuid }}
			className={SIDEBAR_NAV_ITEM_CLASS}
		>
			<FolderClosedIcon className="text-muted-foreground group-data-[status=active]:text-primary" />
			<span className="truncate">{name}</span>
			{busy ? (
				<span className="ml-auto flex shrink-0 items-center pl-2">
					<Spinner
						aria-hidden="true"
						className="size-3.5 text-muted-foreground"
					/>
					<span className="sr-only">{t("videosRootScanning")}</span>
				</span>
			) : warn ? (
				<span className="ml-auto flex shrink-0 items-center pl-2">
					<TriangleAlertIcon
						aria-hidden="true"
						className="size-3.5 text-warning-foreground"
					/>
					<span className="sr-only">{root.phase === "missing" ? t("videosRootMissing") : t("videosRootIncomplete")}</span>
				</span>
			) : (
				<RowCount
					count={root.status?.videos ?? 0}
					label={t("videosLibraryVideos", { count: root.status?.videos ?? 0 })}
				/>
			)}
		</Link>
	)
}

// The Videos contextual sidebar: Home and the kind views with their counts, the library directories with
// their status, and the Libraries dialog below. Text only; every count comes from the index's summary already held.
export function VideosSidebar() {
	const { t } = useTranslation(["videos", "common"])
	const isOnline = useIsOnline()
	const { configQuery, snapshot, roots } = useVideoLibraryView()
	const enabled = roots.filter(root => root.enabled)
	const firstRun = configQuery.status === "success" && roots.length === 0
	const counts = snapshot.summary.total

	return (
		<ResizableSidebarPanel
			module="videos"
			resizeLabel={t("videosSidebarResize")}
		>
			<nav
				aria-label={t("common:moduleVideos")}
				className="flex min-h-0 flex-1 flex-col"
			>
				<div className="flex shrink-0 items-center justify-between gap-2 pt-3 pr-3 pb-1 pl-5.5">
					<h2 className="truncate pt-1 text-[15px] font-semibold">{t("common:moduleVideos")}</h2>
					<Button
						variant="ghost"
						size="icon-sm"
						disabled={!isOnline}
						aria-label={t("videosAddDirectory")}
						title={isOnline ? undefined : t("common:offlineActionDisabled")}
						className="app-region-no-drag"
						onClick={() => {
							openVideosChooser()
						}}
					>
						<PlusIcon />
					</Button>
				</div>
				<div className="flex min-h-0 flex-1 [scrollbar-gutter:stable] flex-col gap-0.5 overflow-y-auto px-3 pt-1 pb-3 app-region-pane">
					<NavRow
						to="/videos"
						icon={HouseIcon}
						label={t("videosHome")}
						exact
						dimmed={firstRun}
					/>
					{firstRun ? (
						<button
							type="button"
							disabled={!isOnline}
							className={cn(SIDEBAR_NAV_ITEM_CLASS, "disabled:pointer-events-none disabled:opacity-50")}
							onClick={() => {
								openVideosChooser()
							}}
						>
							<FolderPlusIcon className="text-muted-foreground" />
							<span className="truncate">{t("videosAddDirectory")}</span>
						</button>
					) : roots.length > 0 ? (
						<>
							<NavRow
								to="/videos/movies"
								icon={FilmIcon}
								label={t("videosMovies")}
							>
								<RowCount
									count={counts.movies}
									label={t("videosCountTitles", { count: counts.movies })}
								/>
							</NavRow>
							<NavRow
								to="/videos/shows"
								icon={TvIcon}
								label={t("videosShows")}
							>
								<RowCount
									count={counts.shows}
									label={t("videosLibraryShows", { count: counts.shows })}
								/>
							</NavRow>
							{counts.other > 0 ? (
								<NavRow
									to="/videos/other"
									icon={BoxIcon}
									label={t("videosOther")}
								>
									<RowCount
										count={counts.other}
										label={t("videosCountTitles", { count: counts.other })}
									/>
								</NavRow>
							) : null}
							{enabled.length > 0 ? (
								<>
									<p className={GROUP_HEADER_CLASS}>{t("videosLibrariesGroup")}</p>
									<ul className="flex flex-col gap-0.5">
										{enabled.map(root => (
											<li key={root.uuid}>
												<RootRow root={root} />
											</li>
										))}
									</ul>
								</>
							) : null}
						</>
					) : null}
				</div>
				{roots.length > 0 ? (
					<div className="shrink-0 px-3 pb-3">
						<Separator className="mb-3 bg-border/50" />
						<button
							type="button"
							className={SIDEBAR_NAV_ITEM_CLASS}
							onClick={() => {
								setVideosLibrariesOpen(true)
							}}
						>
							<Settings2Icon className="text-muted-foreground" />
							<span className="truncate">{t("videosManageLibraries")}</span>
						</button>
					</div>
				) : null}
			</nav>
		</ResizableSidebarPanel>
	)
}
