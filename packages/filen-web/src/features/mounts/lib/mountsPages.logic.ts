import { MOUNTS_OVERVIEW } from "@/features/mounts/lib/indexRedirect.logic"
import { offeredProtocols, primaryRoles, type MountsOffer, type MountsRole } from "@/features/mounts/lib/mountsRoles"

// A Mounts sidebar page: the overview, or a role this app offers.
export type MountsPage = MountsRole | typeof MOUNTS_OVERVIEW

// The sidebar's pages in order, for the previous/next keys: the overview, the primary roles, then the servers.
export function mountsPages(offer: MountsOffer): readonly MountsPage[] {
	return [MOUNTS_OVERVIEW, ...primaryRoles(offer.finder), ...offeredProtocols(offer.platform)]
}

// The page at `pathname` among `pages`: the overview at bare /mounts, a role at /mounts/<role>, else none.
export function mountsPageOf(pathname: string, pages: readonly MountsPage[]): MountsPage | null {
	if (pathname === "/mounts" || pathname === "/mounts/") {
		return MOUNTS_OVERVIEW
	}

	const role = pathname.startsWith("/mounts/") ? pathname.slice("/mounts/".length) : null

	return pages.find(page => page !== MOUNTS_OVERVIEW && page === role) ?? null
}
