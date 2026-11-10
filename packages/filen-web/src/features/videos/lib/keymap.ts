import type { ActionDef } from "@/lib/keymap/registry"

// A focused card's commands, as its menu has them. They act only on the card holding focus, so their single keys stay
// on with single-key shortcuts switched off, as the players' do.
export const VIDEOS_CARD_ACTIONS = [
	{
		id: "videos.play",
		defaultCombo: "space,p",
		scope: "videos",
		descriptionKey: "videos:videosCardKeyPlay",
		hintKey: "videos:videosCardKeyHint",
		keepsCharacterKeys: true
	},
	{
		id: "videos.toggleWatched",
		defaultCombo: "w",
		scope: "videos",
		descriptionKey: "videos:videosCardKeyWatched",
		hintKey: "videos:videosCardKeyHint",
		keepsCharacterKeys: true
	},
	// No sensible default: unassigned, so it can be bound.
	{
		id: "videos.hide",
		defaultCombo: "",
		scope: "videos",
		descriptionKey: "videos:videosCardKeyHide",
		hintKey: "videos:videosCardKeyHint",
		keepsCharacterKeys: true
	}
] as const satisfies readonly ActionDef[]

// The Videos screens' commands: a library view's search box takes the listings' find combo, and `/` opens Videos
// search from anywhere in the module.
export const VIDEOS_ACTIONS: readonly ActionDef[] = [
	{ id: "videos.search", defaultCombo: "mod+f", scope: "videos", descriptionKey: "videos:videosSearchCommand" },
	{ id: "videos.openSearch", defaultCombo: "slash", scope: "videos", descriptionKey: "videos:videosOpenSearchCommand" },
	...VIDEOS_CARD_ACTIONS
]
