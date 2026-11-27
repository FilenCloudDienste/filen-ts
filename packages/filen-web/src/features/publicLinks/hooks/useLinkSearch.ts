import { useEffect, useState } from "react"
import type { DirPublicLink } from "@filen/sdk-rs"
import {
	createLinkSearchSession,
	IDLE_LINK_SEARCH,
	type LinkSearchSession,
	type LinkSearchState
} from "@/features/publicLinks/lib/linkSearch"

// A directory link page's search (lib/linkSearch.ts), for the link the page mounted with. The worker's held listing is
// freed as the page goes.
export function useLinkSearch(link: DirPublicLink): { state: LinkSearchState; session: LinkSearchSession } {
	const [state, setState] = useState<LinkSearchState>(IDLE_LINK_SEARCH)
	const [session] = useState(() => createLinkSearchSession(link, setState))

	useEffect(
		() => () => {
			session.close()
		},
		[session]
	)

	return { state, session }
}
