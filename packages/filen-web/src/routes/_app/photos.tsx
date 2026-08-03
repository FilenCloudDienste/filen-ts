import { createFileRoute } from "@tanstack/react-router"
import { PhotosScreen } from "@/features/photos/screens/photos"
import { routeHead } from "@/lib/head/routeHead"
import { i18n } from "@/lib/i18n"

// Flat page, no splat — mirrors transfers.tsx/playlists.tsx exactly (falls through to appShell's
// default DriveSidebar bucket; no dedicated contextual sidebar of its own).
export const Route = createFileRoute("/_app/photos")({
	head: routeHead({ title: () => [i18n.t("common:modulePhotos")] }),
	component: PhotosScreen
})
