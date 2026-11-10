import type { ActionDef } from "@/lib/keymap/registry"

// The photos grid's commands. Where the wording is drive's they describe themselves with the drive namespace's own
// command copy, rather than a second string to keep in sync. Same combos as drive's, safe because the two routes are
// mutually exclusive. Open, the item menu and the month jumps act on the focused tile, so they are scoped to the grid.
export const PHOTOS_ACTIONS: readonly ActionDef[] = [
	{ id: "photos.selectAll", defaultCombo: "mod+a", scope: "photos", descriptionKey: "drive:driveCommandSelectAll" },
	{ id: "photos.clearSelection", defaultCombo: "escape", scope: "photos", descriptionKey: "common:clearSelection" },
	{
		id: "photos.open",
		defaultCombo: "enter",
		platformDefaults: [{ on: { mac: true }, combo: "enter,mod+arrowdown" }],
		scope: "photos",
		descriptionKey: "drive:driveActionOpen",
		hintKey: "photos:photosCommandHintGrid"
	},
	{
		id: "photos.openItemMenu",
		defaultCombo: "shift+f10",
		scope: "photos",
		descriptionKey: "drive:driveCommandOpenItemMenu",
		hintKey: "photos:photosCommandHintGrid"
	},
	// PageUp and PageDown move by a screenful; with Shift, by month.
	{
		id: "photos.previousMonth",
		defaultCombo: "shift+pageup",
		scope: "photos",
		descriptionKey: "photos:photosCommandPreviousMonth",
		hintKey: "photos:photosCommandHintGrid"
	},
	{
		id: "photos.nextMonth",
		defaultCombo: "shift+pagedown",
		scope: "photos",
		descriptionKey: "photos:photosCommandNextMonth",
		hintKey: "photos:photosCommandHintGrid"
	},
	{ id: "photos.rename", defaultCombo: "f2", scope: "photos", descriptionKey: "drive:driveCommandRename" },
	{
		id: "photos.info",
		defaultCombo: "alt+enter",
		platformDefaults: [{ on: { mac: true }, combo: "mod+i" }],
		scope: "photos",
		descriptionKey: "drive:driveActionInfo"
	},
	{ id: "photos.toggleFavorite", defaultCombo: "f", scope: "photos", descriptionKey: "drive:driveCommandToggleFavorite" },
	// Puts the selection on the drive clipboard, to be pasted into a Cloud Drive directory.
	{ id: "photos.copy", defaultCombo: "mod+c", scope: "photos", descriptionKey: "drive:driveCommandCopy" },
	{ id: "photos.download", defaultCombo: "mod+s", scope: "photos", descriptionKey: "drive:driveCommandDownload" },
	{ id: "photos.share", defaultCombo: "", scope: "photos", descriptionKey: "drive:driveActionShare" },
	{ id: "photos.trash", defaultCombo: "delete,backspace", scope: "photos", descriptionKey: "drive:driveCommandTrash" },
	{ id: "photos.search", defaultCombo: "mod+f", scope: "photos", descriptionKey: "drive:driveCommandSearch" },
	{ id: "photos.favoritesFilter", defaultCombo: "shift+f", scope: "photos", descriptionKey: "photos:photosCommandFavoritesFilter" },
	// No default: a bare digit is the media players' seek key, and Mod+digit is the browser's tab switch.
	{ id: "photos.filterAll", defaultCombo: "", scope: "photos", descriptionKey: "photos:photosCommandFilterAll" },
	{ id: "photos.filterImages", defaultCombo: "", scope: "photos", descriptionKey: "photos:photosCommandFilterImages" },
	{ id: "photos.filterVideos", defaultCombo: "", scope: "photos", descriptionKey: "photos:photosCommandFilterVideos" },
	{ id: "photos.filterRaw", defaultCombo: "", scope: "photos", descriptionKey: "photos:photosCommandFilterRaw" },
	// Bare = and -, not Mod+= and Mod+-, which zoom the page.
	{ id: "photos.densityIncrease", defaultCombo: "equal", scope: "photos", descriptionKey: "photos:photosDensityIncrease" },
	{ id: "photos.densityDecrease", defaultCombo: "minus", scope: "photos", descriptionKey: "photos:photosDensityDecrease" },
	{ id: "photos.manageDirectories", defaultCombo: "", scope: "photos", descriptionKey: "photos:photosCommandManageDirectories" }
]
