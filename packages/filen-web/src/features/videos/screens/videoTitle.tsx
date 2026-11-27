import { useLayoutEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { useNavigate, useRouter } from "@tanstack/react-router"
import { ClapperboardIcon } from "lucide-react"
import { toast } from "sonner"
import { log } from "@/lib/log"
import { errorLabel } from "@/lib/i18n/errorLabel"
import { useFollowMovedTitle } from "@/features/videos/hooks/useFollowMovedTitle"
import { editLibraryConfig, useVideoLibrary, useVideoTitleDetailQuery } from "@/features/videos/queries/library"
import { useCatalogSeriesQuery, useCatalogTitleQuery } from "@/features/videos/queries/catalog"
import { useHistoryEntryKey } from "@/features/videos/hooks/useHistoryEntryKey"
import { recallScroll, rememberScroll, restoreScroll } from "@/features/videos/lib/scrollMemory"
import { TitleScrollContext } from "@/features/videos/lib/titleScroll"
import { titleSubject, type CorrectionKind, type CorrectionSubject } from "@/features/videos/lib/corrections.logic"
import { setKindEdit, type SetAsSource } from "@/features/videos/lib/setAs.logic"
import { detailHeaderMode } from "@/features/videos/lib/titleDetail.logic"
import { probeLandscapeCover } from "@/features/videos/lib/artwork.logic"
import { useStoredProbesQuery } from "@/features/videos/queries/detail"
import { MovieDetail } from "@/features/videos/components/detail/movieDetail"
import { SeriesDetail } from "@/features/videos/components/detail/seriesDetail"
import { CorrectionsDialog } from "@/features/videos/components/detail/correctionsDialog"
import { SetAsShowDialog } from "@/features/videos/components/setAsShowDialog"
import { VideosLoadError } from "@/features/videos/screens/videosHome"
import { LoadingState } from "@/components/loadingState"
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Button } from "@/components/ui/button"
import type { VideoTitleDetail } from "@/workers/videoIndex/view.logic"

// /videos/title/$uuid: a movie's, another video's or a series' page, from the local index (no listing).
export function VideoTitleScreen({ titleId }: { titleId: string }) {
	const { t } = useTranslation("videos")
	const navigate = useNavigate()
	const router = useRouter()
	const library = useVideoLibrary()
	const titleQuery = useCatalogTitleQuery(titleId)
	const title = titleQuery.data ?? null
	const scanning = library.roots.some(root => root.walking || root.state === "loading")
	const detailQuery = useVideoTitleDetailQuery(titleId)
	const detail = detailQuery.data ?? null
	const [editing, setEditing] = useState<CorrectionSubject | null>(null)
	const [showing, setShowing] = useState<SetAsSource[] | null>(null)
	const seriesQuery = useCatalogSeriesQuery(editing !== null)
	// A Matroska movie without a backdrop image may carry a landscape cover its stored probe located (a local read,
	// waited for so the header never switches form after it shows).
	const primary = title?.primary ?? null
	const coverCheck = title !== null && title.backdrop === null && title.kind === "movie" && title.container === "mkv" ? primary : null
	const storedCover = useStoredProbesQuery(coverCheck === null ? [] : [coverCheck.uuid])
	const headerMode =
		title === null
			? "band"
			: detailHeaderMode(title, coverCheck !== null && probeLandscapeCover(storedCover.data?.get(coverCheck.uuid)) !== null)
	const historyKey = useHistoryEntryKey()
	const scrollKey = `${historyKey}:title:${titleId}`
	// Read once: the route keys this screen by title, so another title mounts anew.
	const [restoreOffset] = useState(() => recallScroll(scrollKey))
	const followMoved = useFollowMovedTitle(titleId)
	const [scroller, setScroller] = useState<HTMLDivElement | null>(null)

	// Before paint, so the page never shows at the top first.
	useLayoutEffect(
		() => (scroller === null || restoreOffset === undefined ? undefined : restoreScroll(scroller, restoreOffset)),
		[scroller, restoreOffset]
	)

	function back(): void {
		if (router.history.canGoBack()) {
			router.history.back()

			return
		}

		void navigate({ to: title?.kind === "series" ? "/videos/shows" : title?.kind === "other" ? "/videos/other" : "/videos/movies" })
	}

	// Set as from the More menu: a movie or another video at once (the page stays: the id stays), a show's episode through
	// the dialog asking for the show.
	function setAs(movie: Extract<VideoTitleDetail, { kind: "movie" | "other" }>, kind: CorrectionKind): void {
		const subject = titleSubject(movie)

		if (kind === "episode") {
			setShowing([{ id: movie.title.id, title: movie.title.title, fileName: movie.title.primary?.name ?? "", subject }])

			return
		}

		editLibraryConfig(setKindEdit([subject], kind)).catch((e: unknown) => {
			log.warn("videos.setAs", "setting the title's kind failed", e)
			toast.error(errorLabel(e))
		})
	}

	// A failed read without data to show is an error with a retry, never "not in your library" (and never a spinner
	// held while the roots scan).
	const titleFailed = titleQuery.isError && title === null
	const detailFailed = detailQuery.isError && detail === null

	if (titleFailed || detailFailed) {
		return (
			<VideosLoadError
				error={titleFailed ? titleQuery.error : detailQuery.error}
				onRetry={() => {
					if (titleFailed) {
						void titleQuery.refetch()
					}

					if (detailFailed) {
						void detailQuery.refetch()
					}
				}}
			/>
		)
	}

	if (
		!library.loaded ||
		titleQuery.isPending ||
		(title === null && scanning) ||
		(title !== null && detailQuery.isPending) ||
		(coverCheck !== null && storedCover.isPending)
	) {
		return <LoadingState size="lg" />
	}

	if (title === null || detail === null) {
		return (
			<div className="flex min-h-0 flex-1 items-center justify-center p-6">
				<Empty className="max-w-md border border-dashed">
					<EmptyHeader>
						<EmptyMedia>
							<ClapperboardIcon />
						</EmptyMedia>
						<EmptyTitle>{t("detailNotFound")}</EmptyTitle>
						<EmptyDescription>{t("detailNotFoundDescription")}</EmptyDescription>
					</EmptyHeader>
					<EmptyContent>
						<Button
							variant="outline"
							onClick={back}
						>
							{t("detailBack")}
						</Button>
					</EmptyContent>
				</Empty>
			</div>
		)
	}

	const series = seriesQuery.data ?? []

	return (
		<div
			ref={setScroller}
			className="min-h-0 flex-1 overflow-y-auto"
			onScroll={event => {
				rememberScroll(scrollKey, event.currentTarget.scrollTop)
			}}
		>
			{detail.kind === "series" ? (
				// The episode lists window their rows over this scroller.
				<TitleScrollContext value={scroller}>
					<SeriesDetail
						key={detail.title.id}
						detail={detail}
						headerMode={headerMode}
						onBack={back}
						onEdit={setEditing}
					/>
				</TitleScrollContext>
			) : (
				<MovieDetail
					key={detail.title.id}
					detail={detail}
					headerMode={headerMode}
					onBack={back}
					onEdit={() => {
						setEditing(titleSubject(detail))
					}}
					onSetAs={kind => {
						setAs(detail, kind)
					}}
				/>
			)}
			{editing === null ? null : (
				<CorrectionsDialog
					key={editing.key}
					subject={editing}
					series={series}
					onClose={() => {
						setEditing(null)
					}}
					onMoved={followMoved}
				/>
			)}
			{showing === null ? null : (
				<SetAsShowDialog
					sources={showing}
					onClose={() => {
						setShowing(null)
					}}
					onSaved={id => {
						if (id !== null) {
							followMoved(id)
						}
					}}
				/>
			)}
		</div>
	)
}
