import { createFileRoute } from "@tanstack/react-router"
import { PlaylistsScreen } from "@/features/audio/screens/playlists"

// Flat page, no splat — mirrors transfers.tsx exactly (falls through to appShell's default DriveSidebar
// bucket, same as /transfers; no dedicated contextual sidebar of its own).
export const Route = createFileRoute("/_app/playlists")({ component: PlaylistsScreen })
