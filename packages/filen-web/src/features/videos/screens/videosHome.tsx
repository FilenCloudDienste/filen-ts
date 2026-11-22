import { useState } from "react"
import { useTranslation } from "react-i18next"
import { ClapperboardIcon, TriangleAlertIcon } from "lucide-react"
import { log } from "@/lib/log"
import { asErrorDTO } from "@/lib/sdk/errors"
import { useIsOnline } from "@/lib/useIsOnline"
import { videoLibrary } from "@/features/videos/lib/index"
import { useVideoLibraryView, useVideoRootName } from "@/features/videos/hooks/useVideoLibraryView"
import { videosHomeView, type VideoLibraryRootView, type VideoRootNotice } from "@/features/videos/lib/libraryView.logic"
import { openVideosChooser, setVideosLibrariesOpen } from "@/features/videos/store/useVideosDialogStore"
import { VIDEOS_FIRST_RUN_ACTION_ID } from "@/features/videos/lib/focusTargets"
import { VideosHomeRows } from "@/features/videos/components/homeRows"
import { EmptyState } from "@/features/drive/components/emptyState"
import { LoadingState } from "@/components/loadingState"
import { Button } from "@/components/ui/button"
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"

function rescan(uuid: string): void {
	videoLibrary.rescan(uuid).catch((e: unknown) => {
		log.warn("videos.home", "rescan failed", e)
	})
}

// Nothing in the library yet: one button to the directory chooser. Nothing is listed until one is chosen.
function FirstRun() {
	const { t } = useTranslation("videos")
	const isOnline = useIsOnline()

	return (
		<div className="flex flex-1 overflow-y-auto">
			<Empty className="p-6 sm:p-12">
				<EmptyHeader>
					<EmptyMedia>
						<ClapperboardIcon />
					</EmptyMedia>
					<EmptyTitle>{t("videosFirstRunTitle")}</EmptyTitle>
					<EmptyDescription>{t("videosFirstRunBody")}</EmptyDescription>
				</EmptyHeader>
				<EmptyContent>
					<Button
						id={VIDEOS_FIRST_RUN_ACTION_ID}
						disabled={!isOnline}
						className="w-full sm:w-auto"
						onClick={() => {
							openVideosChooser()
						}}
					>
						{t("videosAddDirectory")}
					</Button>
					<p className="text-muted-foreground">{t("videosFirstRunHint")}</p>
				</EmptyContent>
			</Empty>
		</div>
	)
}

function AllOff() {
	const { t } = useTranslation("videos")

	return (
		<div className="flex flex-1 overflow-y-auto">
			<Empty className="p-6 sm:p-12">
				<EmptyHeader>
					<EmptyMedia>
						<ClapperboardIcon />
					</EmptyMedia>
					<EmptyTitle>{t("videosAllOffTitle")}</EmptyTitle>
					<EmptyDescription>{t("videosAllOffBody")}</EmptyDescription>
				</EmptyHeader>
				<EmptyContent>
					<Button
						className="w-full sm:w-auto"
						onClick={() => {
							setVideosLibrariesOpen(true)
						}}
					>
						{t("videosManageLibraries")}
					</Button>
				</EmptyContent>
			</Empty>
		</div>
	)
}

function Notice({ notice, root }: { notice: VideoRootNotice; root: VideoLibraryRootView | undefined }) {
	const { t } = useTranslation("videos")
	const isOnline = useIsOnline()
	const name = useVideoRootName(notice.uuid, root)
	const text =
		notice.kind === "missing"
			? t("videosMissingBanner", { name })
			: notice.hasPrevious
				? t("videosIncompleteBanner", { name })
				: t("videosIncompleteBannerNoScan", { name })

	return (
		<li className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl bg-warning/15 px-3 py-2 text-sm text-warning-foreground">
			<TriangleAlertIcon
				aria-hidden="true"
				className="size-4 shrink-0"
			/>
			<p className="min-w-0 flex-1">{text}</p>
			{notice.kind === "missing" ? (
				<Button
					variant="outline"
					size="sm"
					onClick={() => {
						setVideosLibrariesOpen(true)
					}}
				>
					{t("videosManageLibraries")}
				</Button>
			) : (
				<Button
					variant="outline"
					size="sm"
					disabled={!isOnline}
					onClick={() => {
						rescan(notice.uuid)
					}}
				>
					{t("videosRescan")}
				</Button>
			)}
		</li>
	)
}

// Every scanned directory came back without a video file: Rescan, or swap the one directory for another.
function EmptyLibrary({ uuids, roots }: { uuids: string[]; roots: readonly VideoLibraryRootView[] }) {
	const { t } = useTranslation("videos")
	const isOnline = useIsOnline()
	const only = uuids.length === 1 ? roots.find(root => root.uuid === uuids[0]) : undefined
	const name = useVideoRootName(only?.uuid ?? "", only)

	return (
		<Empty className="p-6 sm:p-12">
			<EmptyHeader>
				<EmptyMedia>
					<ClapperboardIcon />
				</EmptyMedia>
				<EmptyTitle>{only === undefined ? t("videosLibraryEmptyTitle") : t("videosRootEmptyTitle", { name })}</EmptyTitle>
				<EmptyDescription>{t("videosLibraryEmptyBody")}</EmptyDescription>
			</EmptyHeader>
			<EmptyContent className="sm:flex-row sm:justify-center">
				{only === undefined ? (
					<Button
						className="w-full sm:w-auto"
						onClick={() => {
							setVideosLibrariesOpen(true)
						}}
					>
						{t("videosManageLibraries")}
					</Button>
				) : (
					<>
						<Button
							className="w-full sm:w-auto"
							disabled={!isOnline}
							onClick={() => {
								rescan(only.uuid)
							}}
						>
							{t("videosRescan")}
						</Button>
						<Button
							variant="outline"
							className="w-full sm:w-auto"
							disabled={!isOnline}
							onClick={() => {
								openVideosChooser([only.uuid])
							}}
						>
							{t("videosChooseAnother")}
						</Button>
					</>
				)}
			</EmptyContent>
		</Empty>
	)
}

// A Videos screen whose read failed: the error and a retry (Home, a library view, a title page).
export function VideosLoadError({ error, onRetry }: { error: unknown; onRetry: () => void }) {
	return (
		<EmptyState
			variant="error"
			error={asErrorDTO(error)}
			onRetry={onRetry}
		/>
	)
}

// The library's home: first run, the per-directory notices and, once titles exist, the hero and the rows.
export function VideosHomeScreen() {
	const { configQuery, snapshot, roots } = useVideoLibraryView()
	const [scrollElement, setScrollElement] = useState<HTMLDivElement | null>(null)

	if (configQuery.status === "pending") {
		return <LoadingState size="lg" />
	}

	if (configQuery.status === "error") {
		return (
			<VideosLoadError
				error={configQuery.error}
				onRetry={() => {
					void configQuery.refetch()
				}}
			/>
		)
	}

	const view = videosHomeView({ roots, titleCount: snapshot.summary.titleCount })

	if (view.kind === "firstRun") {
		return <FirstRun />
	}

	if (view.kind === "allOff") {
		return <AllOff />
	}

	return (
		<div
			ref={setScrollElement}
			className="flex min-h-0 flex-1 scrollbar-gutter-stable flex-col overflow-y-auto"
		>
			{view.notices.length > 0 ? (
				<ul className="flex shrink-0 flex-col gap-2 px-4 pt-1 pb-3">
					{view.notices.map(notice => (
						<Notice
							key={notice.uuid}
							notice={notice}
							root={roots.find(root => root.uuid === notice.uuid)}
						/>
					))}
				</ul>
			) : null}
			{view.content.kind === "empty" ? (
				<EmptyLibrary
					uuids={view.content.roots}
					roots={roots}
				/>
			) : (
				<VideosHomeRows
					roots={roots}
					scrollElement={scrollElement}
				/>
			)}
		</div>
	)
}
