// Media feature vocabulary — photos tab, camera upload settings, camera upload error log,
// playlists list, playlist detail, and the add-to-playlist modal.
// Shared keys (cancel, close, delete, rename, remove, select, deselect_all, select_all,
// selected_one/selected_other, settings, enable, cannot_decrypt_toast,
// no_permissions_enable_manually, unknown, …) live in common.ts and must not be redefined here.
export const media = {
	// ── Photos tab ────────────────────────────────────────────────────────────
	/** Photos tab — screen title */
	photos: "Photos",
	/** Photos tab — empty state title shown when no photos are synced yet */
	no_photos: "No photos",
	/** Photos tab — empty state: camera upload is not configured; primary message */
	camera_upload_disabled: "Camera upload is disabled",
	/** Photos tab — empty state: camera upload not configured; secondary hint below the primary message */
	camera_upload_disabled_description: "Enable camera upload to automatically sync your photos and videos.",
	/** Photos tab — empty state button that navigates to the camera upload settings screen */
	enable_camera_upload: "Enable camera upload",
	/** Photos tab / header menu — label for the grid-column-count option.
	 *  {{count}} is the number of columns. Singular: "1 photo per row". Plural: "4 photos per row". */
	photos_per_row_one: "{{count}} photo per row",
	/** Photos tab / header menu — plural form of photos_per_row_one */
	photos_per_row_other: "{{count}} photos per row",
	// favorite_selected, unfavorite_selected, download_selected, make_available_offline_selected
	// and trash_selected live in common.ts.
	/** Photos tab bulk action — save all selected photos/videos to the device media library */
	save_to_device_photos_selected: "Save to device photos",
	/** Photos tab bulk confirm dialog — body text for the "trash selected" confirmation */
	are_you_sure_trash_selected_photos: "Are you sure you want to trash the selected items?",

	// ── Camera upload settings ─────────────────────────────────────────────────
	/** Camera upload settings screen — header title */
	camera_upload: "Camera upload",
	/** Camera upload settings — row title for the albums picker */
	albums: "Albums",
	/** Camera upload settings — subtitle under the albums row */
	albums_description: "Choose which albums to sync.",
	/** Camera upload settings — row title for the cloud destination directory */
	cloud_directory: "Cloud directory",
	/** Camera upload settings — subtitle when no destination directory is selected yet */
	cloud_directory_description: "No directory selected.",
	/** Camera upload settings — subtitle when the root of the cloud drive is selected as destination */
	cloud_directory_root_description: "Cloud drive root",
	/** Camera upload settings — row title for the include-videos toggle */
	videos: "Videos",
	/** Camera upload settings — subtitle under the include-videos toggle */
	videos_description: "Include videos in camera upload.",
	/** Camera upload settings — row title for the allow-cellular toggle */
	cellular: "Cellular",
	/** Camera upload settings — subtitle under the cellular toggle */
	cellular_description: "Allow uploads over mobile data.",
	/** Camera upload settings — row title for the background-sync toggle */
	background: "Background",
	/** Camera upload settings — subtitle under the background toggle */
	background_description: "Continue syncing when the app is in the background.",
	/** Camera upload settings — row title for the pause-on-low-battery toggle */
	low_battery: "Low battery",
	/** Camera upload settings — subtitle under the low-battery toggle */
	low_battery_description: "Pause syncing when the battery is low.",
	/** Camera upload settings — row title for the compress-before-upload toggle */
	compress: "Compress",
	/** Camera upload settings — subtitle under the compress toggle */
	compress_description: "Compress photos before uploading to save storage.",
	/** Camera upload settings — row title for the only-upload-after-activation toggle */
	after_activation: "After activation",
	/** Camera upload settings — subtitle under the after-activation toggle */
	after_activation_description: "Only upload media captured after camera upload was first activated.",

	// ── Camera upload albums picker ───────────────────────────────────────────
	/** Albums picker screen — header title (same key reused from settings row) */
	no_albums: "No albums found.",

	// ── Camera upload error log ───────────────────────────────────────────────
	/** Camera upload errors screen — header title */
	camera_upload_errors: "Camera upload errors",
	/** Camera upload errors — menu action: clear the error list and retry */
	clear_errors: "Clear errors",
	/** Camera upload errors — empty state title shown when there are no errors */
	no_camera_upload_errors: "No errors",
	/** Camera upload error row / generic error fallback when no message is available */
	unknown_error: "Unknown error",

	// ── Playlists list ────────────────────────────────────────────────────────
	/** Playlists screen — header title */
	playlists: "Playlists",
	/** Playlists — empty state title */
	no_playlists: "No playlists",
	/** Playlists — action-sheet / menu item: play the playlist from the beginning */
	play: "Play",
	/** Playlists — action-sheet item: add all tracks of this playlist to the playback queue */
	add_to_queue: "Add to queue",
	/** Playlists — action-sheet item: add one or more tracks to one or more playlists */
	add_to_playlist: "Add to playlist",
	/** Playlists — action-sheet / menu item: add tracks to the playlist */
	add_tracks: "Add tracks",
	/** Playlists — long-press action-sheet / header menu item: rename a playlist */
	rename_playlist: "Rename playlist",
	/** Playlists — rename / create dialog: text above the input field */
	enter_playlist_name: "Enter a name for the playlist.",
	/** Playlists — rename / create dialog: input placeholder */
	playlist_name_placeholder: "Playlist name",
	/** Playlists — header menu item: create a new playlist */
	create_playlist: "Create playlist",
	/** Playlists — create dialog: title */
	new_playlist: "New playlist",
	/** Playlists — destructive long-press action: delete a single playlist */
	delete_playlist: "Delete playlist",
	/** Playlists — delete confirmation dialog body */
	delete_playlist_confirm: "Are you sure you want to delete this playlist?",
	/** Playlists bulk action — bulk-delete confirmation dialog body */
	delete_selected_playlists_confirm: "Are you sure you want to delete the selected playlists?",
	/** Playlists — playlist row subtitle.
	 *  Singular: "1 track, updated Jan 1". Plural: "5 tracks, updated Jan 1".
	 *  {{count}} is the number of tracks. {{date}} is the formatted last-updated date. */
	tracks_updated_one: "{{count}} track, updated {{date}}",
	/** Playlists — plural form of tracks_updated_one */
	tracks_updated_other: "{{count}} tracks, updated {{date}}",

	// ── Playlist detail ───────────────────────────────────────────────────────
	/** Playlist detail — empty state title shown when the playlist has no tracks yet */
	no_tracks: "No tracks",
	/** Playlist detail track action-sheet — remove the track from this playlist */
	remove_from_playlist: "Remove from playlist",
	/** Playlist detail bulk action — remove all selected tracks; confirmation dialog body */
	are_you_sure_remove_selected_from_playlist: "Are you sure you want to remove the selected tracks from this playlist?",

	// ── Select-playlists modal toolbar ────────────────────────────────────────
	/** Floating confirm button in the add-to-playlist modal.
	 *  Singular: "Select 1 playlist". Plural: "Select 3 playlists".
	 *  {{count}} is the number of currently selected playlists. */
	select_n_playlists_one: "Select {{count}} playlist",
	/** Plural form of select_n_playlists_one */
	select_n_playlists_other: "Select {{count}} playlists",

	// ── Audio player toolbar (playlists/_layout.tsx) ──────────────────────────
	/** Audio player mini-bar — title shown when nothing is playing */
	not_playing: "Not playing",
	/** Audio player mini-bar — fallback track title when no metadata title is available */
	unknown_title: "Unknown title",
	/** Audio player mini-bar — fallback artist name when no metadata artist is available */
	unknown_artist: "Unknown artist"
} as const
