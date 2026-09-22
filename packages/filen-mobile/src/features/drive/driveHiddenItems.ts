import { isHiddenName } from "@filen/shared"
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
 * Applied to the name the row actually displays rather than the raw metadata — so an item whose
 * name could not be decrypted is judged by its `cannot_decrypt_…` placeholder and stays visible.
 * Hiding something the user cannot even identify would leave them no way to find it again.
 */
export function isHiddenDriveItem(item: DriveItem): boolean {
	return isHiddenName(driveItemDisplayName(item))
}
