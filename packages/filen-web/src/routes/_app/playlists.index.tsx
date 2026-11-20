import { createFileRoute } from "@tanstack/react-router"

// Bare /playlists: the layout (playlists.tsx) shows the last opened playlist, else the first.
export const Route = createFileRoute("/_app/playlists/")({})
