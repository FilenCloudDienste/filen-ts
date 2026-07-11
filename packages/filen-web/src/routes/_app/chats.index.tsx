import { createFileRoute } from "@tanstack/react-router"
import { ChatsPlaceholder } from "@/features/chats/components/thread/chatsPlaceholder"

// The bare /chats index. Unlike notes' index (which auto-redirects to the first note), chats does NOT
// auto-select a conversation: old-web selection is explicit and opening a conversation is a deliberate act
// (it never auto-marks-read as a side effect of merely being visible), so the index shows a select prompt
// rather than yanking the user into an arbitrary thread. Also the natural landing on the
// zero-conversation e2e account. Auth-guarded by the _app layout.
export const Route = createFileRoute("/_app/chats/")({ component: ChatsIndexPage })

function ChatsIndexPage() {
	return <ChatsPlaceholder />
}
