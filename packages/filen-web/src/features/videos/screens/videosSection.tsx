import { useTranslation } from "react-i18next"
import { useRouterState } from "@tanstack/react-router"
import { useVideoLibraryView, useVideoRootNames } from "@/features/videos/hooks/useVideoLibraryView"
import { videosSection } from "@/features/videos/lib/libraryView.logic"
import type { GridSource } from "@/features/videos/lib/videoGrid.logic"
import { VideoGrid } from "@/features/videos/components/videoGrid"
import { VideosLoadError } from "@/features/videos/screens/videosHome"
import { LoadingState } from "@/components/loadingState"

// A library view (Movies, Shows, Other, one directory) under the shared header: its grid.
export function VideosSectionScreen() {
	const { t } = useTranslation("videos")
	const pathname = useRouterState({ select: state => state.location.pathname })
	const { configQuery, roots } = useVideoLibraryView()
	const names = useVideoRootNames(roots)
	const section = videosSection(pathname)

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

	let source: GridSource
	let name: string

	switch (section?.kind) {
		case "movies":
			source = { kind: "movies" }
			name = t("videosMovies")
			break
		case "shows":
			source = { kind: "shows" }
			name = t("videosShows")
			break
		case "other":
			source = { kind: "other" }
			name = t("videosOther")
			break
		case "library":
			source = { kind: "root", uuid: section.uuid }
			name = names.get(section.uuid) ?? ""
			break
		default:
			return null
	}

	return (
		<VideoGrid
			key={source.kind === "root" ? `root:${source.uuid}` : source.kind}
			source={source}
			name={name}
			rootNames={names}
		/>
	)
}
