import { isOfferedRole, type MountsOffer, type MountsRole } from "@/features/mounts/lib/mountsRoles"

// What the Mounts index remembers besides a role: the overview itself, chosen from the sidebar.
export const MOUNTS_OVERVIEW = "overview"

// Where bare /mounts goes: the last opened page (a role) while this app offers it, the overview (null), or undecided
// (undefined) while the stored value is read.
export function mountsIndexRedirectTarget(stored: string | null | undefined, offer: MountsOffer): MountsRole | null | undefined {
	if (stored === undefined) {
		return undefined
	}

	return stored !== null && isOfferedRole(stored, offer) ? stored : null
}
