import { createFileRoute, Outlet } from "@tanstack/react-router"

// Notes layout parent. Flat-file routing nests notes.index (/notes) and notes.$uuid (/notes/$uuid)
// under this route, so it must render an Outlet for the selected child to appear in the shell's main
// card. Auth-guarded by the _app layout; holds no chrome of its own (the sidebar lives in the shell).
export const Route = createFileRoute("/_app/notes")({ component: NotesLayout })

function NotesLayout() {
	return <Outlet />
}
