import { type, type Type } from "arktype"
import { kvPreference } from "@/lib/storage/preference"
import { log } from "@/lib/log"
import { isValidHexColor } from "@filen/shared"
import { MAX_RECENT_DIR_COLORS } from "@/features/drive/lib/dirColor"

const recentSchema: Type<string[]> = type("string[]")

const preference = kvPreference({
	key: "drive.recentDirColors.v1",
	schema: recentSchema,
	fallback: [],
	// A stored list is untrusted: keep only well-formed lowercase hexes, capped.
	normalize: list => list.filter(each => isValidHexColor(each) && each === each.toLowerCase()).slice(0, MAX_RECENT_DIR_COLORS)
})

export async function loadRecentDirColors(): Promise<string[]> {
	try {
		return await preference.get()
	} catch (e) {
		log.warn("recentDirColors", "read failed", e)

		return []
	}
}

export function saveRecentDirColors(list: string[]): void {
	void preference.set(list).catch((e: unknown) => {
		log.warn("recentDirColors", "write failed", e)
	})
}
