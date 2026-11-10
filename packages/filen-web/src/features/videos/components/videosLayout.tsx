import { useEffect } from "react"
import { Outlet, useNavigate, useRouterState } from "@tanstack/react-router"
import { log } from "@/lib/log"
import { OUTSIDE_OVERLAYS, useAction } from "@/lib/keymap/useAction"
import { pathIsUnder } from "@/features/shell/lib/appShell.logic"
import { useVideoLibrary } from "@/features/videos/queries/library"
import { watchState } from "@/features/videos/lib/watchState"
import { useVideoLibraryView } from "@/features/videos/hooks/useVideoLibraryView"
import { showsVideosTabs, videosSection } from "@/features/videos/lib/libraryView.logic"
import { closeVideosDialogs } from "@/features/videos/store/useVideosDialogStore"
import { VideosHeader } from "@/features/videos/components/videosHeader"
import { VideosTabs } from "@/features/videos/components/videosTabs"
import { VideosDialogsHost } from "@/features/videos/components/videosDialogsHost"

// Every /videos route: opens the library and the watch state, and holds the shared header with the scan line,
// the phone tabs and the dialogs. Leaving Videos closes any dialog left open.
export function VideosLayout() {
	const pathname = useRouterState({ select: state => state.location.pathname })
	const { configQuery, roots } = useVideoLibraryView()
	const section = videosSection(pathname)
	const navigate = useNavigate()

	useVideoLibrary()

	// `/` opens search; typing it into a field stays the field's (the hotkey skips form fields). Not over the player,
	// whose keys are its own.
	const hasLibrary = roots.length > 0
	const overPlayer = pathIsUnder(pathname, "/videos/watch")

	useAction(
		"videos.openSearch",
		event => {
			if (!hasLibrary || overPlayer) {
				return
			}

			event.preventDefault()
			void navigate({ to: "/videos/search" })
		},
		OUTSIDE_OVERLAYS,
		[hasLibrary, overPlayer, navigate]
	)

	useEffect(() => {
		watchState.open().catch((e: unknown) => {
			log.warn("videos.watchState", "opening the watch state failed", e)
		})

		return closeVideosDialogs
	}, [])

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			{section === null || configQuery.status !== "success" ? null : (
				<VideosHeader
					section={section}
					roots={roots}
				/>
			)}
			<div className="flex min-h-0 flex-1 flex-col overflow-hidden">
				<Outlet />
			</div>
			{showsVideosTabs({ pathname, hasLibrary: roots.length > 0 }) ? <VideosTabs /> : null}
			<VideosDialogsHost />
		</div>
	)
}
