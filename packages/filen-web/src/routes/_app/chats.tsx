import { createFileRoute, Outlet } from "@tanstack/react-router"

// Chats layout parent. Flat-file routing nests chats.index (/chats) and chats.$uuid (/chats/$uuid) under
// this route, so it must render an Outlet for the selected child to appear in the shell's main card.
// Auth-guarded by the _app layout; holds no chrome of its own (the sidebar lives in the shell).
export const Route = createFileRoute("/_app/chats")({ component: ChatsLayout })

function ChatsLayout() {
	return <Outlet />
}
