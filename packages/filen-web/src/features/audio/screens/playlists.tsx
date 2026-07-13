import { useTranslation } from "react-i18next"
import { PlaylistsPanel } from "@/features/audio/components/playlistsPanel"

// Full-page playlists surface — the rail's dedicated entry (iconRail.tsx) routes straight here, fixing
// the old reachability gap where playlists only lived inside the now-playing popover's Playlists tab and
// so needed a queue playing first to even open. Header shape mirrors TransfersScreen's own
// (transfers/screens/transfers.tsx): a plain h-14 title row, no contextual sidebar. PlaylistsPanel
// supplies the actual CRUD body (list/create/rename/delete/detail), restructured for a full screen
// rather than its old popover-constrained max-height box.
export function PlaylistsScreen() {
	const { t } = useTranslation("common")

	return (
		<>
			<header className="flex h-14 shrink-0 items-center px-4">
				<h1 className="text-sm font-medium">{t("modulePlaylists")}</h1>
			</header>
			<div className="flex min-h-0 flex-1 flex-col overflow-hidden">
				<PlaylistsPanel />
			</div>
		</>
	)
}
