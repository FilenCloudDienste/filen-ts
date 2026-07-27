import secureStore, { useSecureStore } from "@/lib/secureStore"
import { driveItemDisplayName } from "@/lib/decryption"
import type { DriveItem } from "@/types"

export const HIDE_HIDDEN_ITEMS_SECURE_STORE_KEY = "drive.hideHiddenItems"

/**
 * Default OFF, deliberately unlike Finder and File Explorer. Those hide dot-prefixed entries out
 * of the box because their users mostly did not create them; a Filen drive holds what its owner
 * put there, so nothing is hidden until the owner asks for it. Toggle lives in Appearance settings,
 * alongside the sort and view-mode preferences it is a sibling of.
 */
export const DEFAULT_HIDE_HIDDEN_ITEMS = false

export function useHideHiddenItems(): [boolean, (next: boolean | ((prev: boolean) => boolean)) => void] {
	return useSecureStore<boolean>(HIDE_HIDDEN_ITEMS_SECURE_STORE_KEY, DEFAULT_HIDE_HIDDEN_ITEMS)
}

/**
 * One-shot read for action handlers that need the preference at the moment they run rather than as
 * reactive state — the create / rename flows, which have to tell the user when the name they just
 * typed will be filtered out from under them.
 */
export async function readHideHiddenItems(): Promise<boolean> {
	const stored = await secureStore.get<boolean>(HIDE_HIDDEN_ITEMS_SECURE_STORE_KEY)

	return typeof stored === "boolean" ? stored : DEFAULT_HIDE_HIDDEN_ITEMS
}

/**
 * The dot-prefix convention. Leading whitespace is trimmed first: a name created elsewhere (web,
 * desktop, another client) can carry it, and " .env" is the same hidden file to a user.
 */
export function isHiddenName(name: string): boolean {
	return name.trim().startsWith(".")
}

/**
 * Applied to the name the row actually displays rather than the raw metadata — so an item whose
 * name could not be decrypted is judged by its `cannot_decrypt_…` placeholder and stays visible.
 * Hiding something the user cannot even identify would leave them no way to find it again.
 */
export function isHiddenDriveItem(item: DriveItem): boolean {
	return isHiddenName(driveItemDisplayName(item))
}

/**
 * Whether a search hit lives inside a hidden directory. `parentPath` is the hit's `/`-joined chain
 * of ancestor names relative to the search root (empty for a direct child).
 *
 * Search is recursive, so filtering on the hit's own name alone would hide `.thumb` from the
 * browser while flooding the results with everything inside it — and the search row renders the
 * full relative path, printing the hidden directory's name straight back at the user.
 */
export function isHiddenSearchPath(parentPath: string): boolean {
	return parentPath.split("/").some(segment => isHiddenName(segment))
}

/**
 * Display-only filter, applied where a listing is rendered rather than where it is fetched: the
 * query cache stays complete, so flipping the toggle re-renders instead of refetching, and every
 * consumer that reasons about what is really in a directory (transfers, offline sync, the socket
 * updaters) is untouched.
 *
 * `searchParentPaths` is supplied for cache-search results only, and extends the rule from the
 * hit's own name to its ancestry.
 *
 * WHERE this may be applied is a separate question, answered by `hiddenFilterAppliesTo` in
 * driveSelectors — this module only decides WHAT counts as hidden.
 */
export function filterHiddenDriveItems<T extends DriveItem>({
	items,
	hide,
	searchParentPaths
}: {
	items: T[]
	hide: boolean
	searchParentPaths?: Map<string, string>
}): T[] {
	if (!hide) {
		return items
	}

	return items.filter(item => {
		if (isHiddenDriveItem(item)) {
			return false
		}

		const parentPath = searchParentPaths?.get(item.data.uuid)

		return parentPath === undefined || !isHiddenSearchPath(parentPath)
	})
}
