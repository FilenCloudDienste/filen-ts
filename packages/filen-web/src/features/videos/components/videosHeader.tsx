import { useState } from "react"
import { useTranslation } from "react-i18next"
import { Link } from "@tanstack/react-router"
import { SearchIcon, Settings2Icon } from "lucide-react"
import { log } from "@/lib/log"
import { videoLibrary } from "@/features/videos/lib/index"
import { useVideoRootNames } from "@/features/videos/hooks/useVideoLibraryView"
import { busyRoots, scanTransition, type VideoLibraryRootView, type VideosSection } from "@/features/videos/lib/libraryView.logic"
import { VIDEOS_HEADING_ID } from "@/features/videos/lib/focusTargets"
import { setVideosLibrariesOpen } from "@/features/videos/store/useVideosDialogStore"
import { VideosDensityControls } from "@/features/videos/components/videosDensityControls"
import { Button, buttonVariants } from "@/components/ui/button"

const SECTION_KEY = {
	home: "videosHome",
	movies: "videosMovies",
	shows: "videosShows",
	other: "videosOther",
	search: "videosSearch"
} as const

// The scan line under the header: a thin indeterminate bar, which directory is scanned, and Stop. A scan is one
// request whose result arrives at once, so there is no running count. Stopping drops the scan's result; the walk
// itself can't be aborted. Directories whose scan never started get Retry instead.
function ScanLine({ busy, names }: { busy: readonly VideoLibraryRootView[]; names: ReadonlyMap<string, string> }) {
	const { t } = useTranslation("videos")
	const walking = busy.filter(root => root.phase === "scanning")
	const name = names.get(busy[0]?.uuid ?? "") ?? ""

	return (
		<>
			<div
				aria-hidden="true"
				className="relative h-0.5 shrink-0 overflow-hidden bg-foreground/10"
			>
				<div className="absolute inset-y-0 left-0 w-1/3 animate-indeterminate bg-primary motion-reduce:animate-none" />
			</div>
			<div className="flex min-h-11 shrink-0 items-center gap-3 px-4 py-1.5">
				<p className="min-w-0 flex-1 truncate text-sm text-muted-foreground">
					{busy.length > 1 ? t("videosScanningMore", { name, count: busy.length - 1 }) : t("videosScanning", { name })}
				</p>
				{walking.length > 0 ? (
					<Button
						variant="outline"
						size="sm"
						aria-label={t("videosStopScanLabel")}
						onClick={() => {
							for (const root of walking) {
								videoLibrary.stopScan(root.uuid).catch((e: unknown) => {
									log.warn("videos.scan", "stopping a scan failed", e)
								})
							}
						}}
					>
						{t("videosStopScan")}
					</Button>
				) : (
					<Button
						variant="outline"
						size="sm"
						onClick={() => {
							videoLibrary.retry(busy.map(root => root.uuid)).catch((e: unknown) => {
								log.warn("videos.scan", "retrying a scan failed", e)
							})
						}}
					>
						{t("videosRetryScan")}
					</Button>
				)}
			</div>
		</>
	)
}

// The Videos screens' shared header: "Videos · <section>", search and the Libraries button once there is a
// library, and the scan line while a directory is scanned. Scans starting and finishing are announced through
// one polite live region that is mounted empty.
export function VideosHeader({ section, roots }: { section: VideosSection; roots: readonly VideoLibraryRootView[] }) {
	const { t } = useTranslation(["videos", "common", "drive"])
	const names = useVideoRootNames(roots)
	const busy = busyRoots(roots)
	const busyKey = busy.map(root => root.uuid).join(",")
	const [tracked, setTracked] = useState({ key: busyKey, uuids: busy.map(root => root.uuid) })
	// `n` alternates a trailing no-break space, so an announcement equal to the previous one is still a change.
	const [announcement, setAnnouncement] = useState({ text: "", n: 0 })

	// Adjusted during render rather than in an effect: what started or finished is known the render the line changes.
	if (tracked.key !== busyKey) {
		const { done, started } = scanTransition(tracked.uuids, roots)
		const startedName = started === undefined ? "" : (names.get(started.uuid) ?? "")
		const text =
			done.length > 0
				? done.map(root => t("videosScanDone", { name: names.get(root.uuid) ?? "", count: root.status?.videos ?? 0 })).join(". ")
				: startedName.length > 0
					? t("videosScanning", { name: startedName })
					: ""

		setTracked({ key: busyKey, uuids: busy.map(root => root.uuid) })

		if (text.length > 0) {
			setAnnouncement(previous => ({ text, n: previous.n + 1 }))
		}
	}

	const sectionName = section.kind === "library" ? (names.get(section.uuid) ?? "") : t(SECTION_KEY[section.kind])

	return (
		<>
			<header className="flex h-14 shrink-0 items-center justify-between gap-3 px-4 app-region-chrome">
				<h1
					id={VIDEOS_HEADING_ID}
					tabIndex={-1}
					className="flex min-w-0 items-baseline gap-1.5 text-sm font-medium outline-none"
				>
					<span className="shrink-0">{t("common:moduleVideos")}</span>
					{roots.length === 0 || sectionName.length === 0 ? null : (
						<>
							<span
								aria-hidden="true"
								className="text-muted-foreground"
							>
								·
							</span>
							<span className="truncate font-normal text-muted-foreground">{sectionName}</span>
						</>
					)}
				</h1>
				{roots.length === 0 ? null : (
					<div className="flex shrink-0 items-center gap-1">
						{section.kind === "home" || section.kind === "search" ? null : <VideosDensityControls />}
						{/* Phones reach search from the tabs. */}
						<Link
							to="/videos/search"
							aria-label={t("videosSearch")}
							className={buttonVariants({ variant: "ghost", size: "icon-sm", className: "max-md:hidden" })}
						>
							<SearchIcon />
						</Link>
						<Button
							variant="ghost"
							size="icon-sm"
							aria-label={t("videosManageLibraries")}
							onClick={() => {
								setVideosLibrariesOpen(true)
							}}
						>
							<Settings2Icon />
						</Button>
					</div>
				)}
			</header>
			{busy.length > 0 ? (
				<ScanLine
					busy={busy}
					names={names}
				/>
			) : null}
			<p
				role="status"
				className="sr-only"
			>
				{announcement.n % 2 === 1 ? `${announcement.text}\u00a0` : announcement.text}
			</p>
		</>
	)
}
