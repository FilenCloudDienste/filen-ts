import { createFileRoute } from "@tanstack/react-router"
import { useChats } from "@/features/chats/queries/chats"
import { MessageThread } from "@/features/chats/components/thread/messageThread"
import { ChatsPlaceholder } from "@/features/chats/components/thread/chatsPlaceholder"

// The selected-conversation route. `uuid` is a selection key, not a path hierarchy — the conversation is
// resolved from the one global chats list cache (no per-uuid fetch), so switching conversations reuses
// already-loaded metadata. A uuid absent from the list (stale link) resolves to undefined → the select
// prompt (loading while the list is still in flight). Auth-guarded by the _app layout.
export const Route = createFileRoute("/_app/chats/$uuid")({ component: ChatDetailPage })

function ChatDetailPage() {
	const { uuid } = Route.useParams()
	const chatsQuery = useChats()
	const chat = chatsQuery.data?.find(c => c.uuid === uuid)

	if (chat === undefined) {
		return <ChatsPlaceholder loading={chatsQuery.isPending} />
	}

	return <MessageThread chat={chat} />
}
