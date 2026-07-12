import { createFileRoute, Outlet } from "@tanstack/react-router"
import { ChatConnectionBanner } from "@/features/chats/components/chatConnectionBanner"

// Chats layout parent. Flat-file routing nests chats.index (/chats) and chats.$uuid (/chats/$uuid) under
// this route, so it must render an Outlet for the selected child to appear in the shell's main card.
// Auth-guarded by the _app layout; the only chrome of its own is the socket disconnect strip pinned above
// the selected conversation (the sidebar itself lives in the shell).
export const Route = createFileRoute("/_app/chats")({ component: ChatsLayout })

function ChatsLayout() {
	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<ChatConnectionBanner />
			<Outlet />
		</div>
	)
}
