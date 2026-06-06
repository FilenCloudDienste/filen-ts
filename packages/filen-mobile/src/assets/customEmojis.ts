import data from "@/assets/customEmojis.json"

export type CustomEmoji = {
	id: string
	name: string
	keywords: string[]
	skins: {
		src: string
	}[]
}

export const customEmojis: CustomEmoji[] = data
