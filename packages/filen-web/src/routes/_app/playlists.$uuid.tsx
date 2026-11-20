import { createFileRoute } from "@tanstack/react-router"

// One playlist, rendered by the layout (playlists.tsx) from this route's `uuid`. A uuid that is not in the list (a
// deleted playlist, a stale link) falls back like bare /playlists does.
export const Route = createFileRoute("/_app/playlists/$uuid")({})
