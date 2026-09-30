import { useEffect } from "react"
import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { useChats } from "@/features/chats/queries/chats"
import { useAccountQuery } from "@/queries/account"
import { useContactsQuery } from "@/features/contacts/queries/contacts"
import { useBlockedUsers } from "@/features/contacts/hooks/useBlockedUsers"
import { chatsIndexRedirectTarget } from "@/features/chats/lib/indexRedirect.logic"
import { readLastOpened, useLastOpened } from "@/features/shell/lib/lastOpened"
import { ChatsPlaceholder } from "@/features/chats/components/thread/chatsPlaceholder"

// The bare /chats index reopens the last opened conversation (the rail links here, so opening the module is
// a deliberate navigation to it) while the sidebar still lists it; otherwise it shows the select prompt,
// which is also the landing on an account with no conversations. The loader warms the stored value so the
// decision needs no extra render. Auth-guarded by the _app layout.
export const Route = createFileRoute("/_app/chats/")({
	loader: async () => {
		await readLastOpened("chats")
	},
	component: ChatsIndexPage
})

function ChatsIndexPage() {
	const navigate = useNavigate()
	const storedUuid = useLastOpened("chats")
	const chatsQuery = useChats()
	const accountQuery = useAccountQuery()
	// Same query the sidebar enables, so no extra request; waited on so a blocked 1:1 is never reopened.
	const contactsPending = useContactsQuery({ enabled: true }).isPending
	const blocked = useBlockedUsers(true)
	const target = chatsIndexRedirectTarget({
		storedUuid,
		chats: chatsQuery.data,
		pending: chatsQuery.isPending || accountQuery.isPending || contactsPending,
		currentUserId: accountQuery.data?.id,
		blocked
	})

	useEffect(() => {
		if (typeof target === "string") {
			void navigate({ to: "/chats/$uuid", params: { uuid: target }, replace: true })
		}
	}, [target, navigate])

	return <ChatsPlaceholder loading={target !== null} />
}
