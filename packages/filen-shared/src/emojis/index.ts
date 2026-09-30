import data from "./customEmojis.json"

// Filen's image-backed custom emoji pack (each image on cdn.filen.io). Kept behind the "@filen/shared/emojis"
// subpath, off the barrel, so the ~200 KB JSON is only parsed where a chat surface imports it.
export type CustomEmojiPackEntry = {
	id: string
	name: string
	keywords: string[]
	skins: {
		src: string
	}[]
}

export const CUSTOM_EMOJI_PACK: readonly CustomEmojiPackEntry[] = data
