import type { ActionDef } from "@/lib/keymap/registry"

// The /playlists page's commands, on the playlist the focused sidebar row names, else the one on screen. The route
// never shows with drive or notes, so N, F2 and Delete/Backspace mirror theirs. Add tracks stays unset (Mod+Shift+A
// is Chrome's tab search), and so do play and shuffle, which have no key mature players agree on.
//
// The track moves act on the focused track row only (ref-scoped to the track table), the keyboard's way to do what
// dragging a row does. The picker's keys act inside the Add tracks dialog only.
export const PLAYLISTS_ACTIONS: readonly ActionDef[] = [
	{ id: "playlists.newPlaylist", defaultCombo: "n", scope: "playlists", descriptionKey: "audio:newPlaylist" },
	{ id: "playlists.rename", defaultCombo: "f2", scope: "playlists", descriptionKey: "audio:playlistsCommandRename" },
	{ id: "playlists.delete", defaultCombo: "delete,backspace", scope: "playlists", descriptionKey: "audio:playlistsCommandDelete" },
	{ id: "playlists.play", defaultCombo: "", scope: "playlists", descriptionKey: "audio:playlistsCommandPlay" },
	{ id: "playlists.shuffle", defaultCombo: "", scope: "playlists", descriptionKey: "audio:playlistsCommandShuffle" },
	{ id: "playlists.addTracks", defaultCombo: "", scope: "playlists", descriptionKey: "audio:addTracks" },
	{
		id: "playlists.moveTrackUp",
		defaultCombo: "alt+shift+arrowup",
		scope: "playlists",
		descriptionKey: "audio:playlistsCommandMoveTrackUp",
		hintKey: "audio:playlistsHintTrackRow"
	},
	{
		id: "playlists.moveTrackDown",
		defaultCombo: "alt+shift+arrowdown",
		scope: "playlists",
		descriptionKey: "audio:playlistsCommandMoveTrackDown",
		hintKey: "audio:playlistsHintTrackRow"
	},
	{
		id: "playlists.pickerSelectAll",
		defaultCombo: "mod+a",
		scope: "playlists",
		descriptionKey: "audio:playlistsCommandPickerSelectAll",
		hintKey: "audio:playlistsHintPicker"
	},
	{
		id: "playlists.pickerFilter",
		defaultCombo: "slash",
		scope: "playlists",
		descriptionKey: "audio:playlistsCommandPickerFilter",
		hintKey: "audio:playlistsHintPicker"
	},
	{
		id: "playlists.pickerConfirm",
		defaultCombo: "mod+enter",
		scope: "playlists",
		descriptionKey: "audio:playlistsCommandPickerConfirm",
		hintKey: "audio:playlistsHintPicker"
	}
]
