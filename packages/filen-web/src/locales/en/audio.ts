// English source catalog — "audio" namespace: the persistent audio module (queue engine + mini-player
// / now-playing transport, docked in the shell), separate from the preview overlay's own inline media
// arm. Flat `as const` object, camelCase keys, no literal '.'/':'  (this app runs real i18next
// namespaces with keySeparator/nsSeparator both ON), same rules as every other catalog.
export const audio = {
	// ── Transport controls (accessible labels) ─────────────────────────────
	/** Play/resume the current track */
	play: "Play",
	/** Pause playback */
	pause: "Pause",
	/** Skip to the next track */
	next: "Next track",
	/** Skip to the previous track (or restart the current one if past the start) */
	previous: "Previous track",
	/** Toggle shuffle */
	shuffle: "Shuffle",
	/** Cycle the repeat mode (off → all → one) */
	loop: "Repeat",
	/** Repeat mode — off */
	loopOff: "Repeat off",
	/** Repeat mode — repeat the whole queue */
	loopAll: "Repeat all",
	/** Repeat mode — repeat the current track */
	loopOne: "Repeat one",
	/** Mute audio output */
	mute: "Mute",
	/** Unmute audio output */
	unmute: "Unmute",
	/** Volume slider label */
	volume: "Volume",
	/** Seek slider label */
	seek: "Seek",

	// ── Now-playing surface ────────────────────────────────────────────────
	/** Shown in place of a track name before anything is queued */
	nothingPlaying: "Nothing playing",
	/** Fallback when a track has no metadata artist */
	unknownArtist: "Unknown artist",
	/** Accessible label for the whole player bar landmark */
	playerLabel: "Audio player",
	/** Queue toggle button / now-playing panel heading */
	queue: "Queue",
	/** Accessible label for the queue toggle button */
	showQueue: "Show queue",
	/** Empty a full queue and hide the player */
	clearQueue: "Clear queue",
	/** Per-row action removing one track from the queue */
	removeFromQueue: "Remove from queue",
	/** Per-row action playing a queued track immediately */
	playTrack: "Play",
	/** Sub-count under the panel heading, singular */
	queueCount_one: "{{count}} track",
	/** Sub-count under the panel heading, plural */
	queueCount_other: "{{count}} tracks",

	// ── Keyboard-shortcut descriptions (keymap registry) ───────────────────
	/** Toggle play/pause via keyboard */
	commandPlayPause: "Play / pause",
	/** Skip to next track via keyboard */
	commandNext: "Next track",
	/** Skip to previous track via keyboard */
	commandPrevious: "Previous track",

	// ── Status / errors ────────────────────────────────────────────────────
	/** Toast when a folder/selection is enqueued but some tracks couldn't be decrypted and were skipped, singular */
	droppedUndecryptable_one: "{{count}} track couldn't be decrypted and was skipped",
	/** Toast when a folder/selection is enqueued but some tracks couldn't be decrypted and were skipped, plural */
	droppedUndecryptable_other: "{{count}} tracks couldn't be decrypted and were skipped",
	/** Generic playback-failure label surfaced when a track can't be played and the queue settles */
	playbackFailed: "Couldn't play this track",

	// ── Now-playing panel tabs ──────────────────────────────────────────────
	/** Accessible label for the Queue/Playlists tab list */
	nowPlayingTabsLabel: "Now playing panel sections",

	// ── Playlists ────────────────────────────────────────────────────────────
	/** Playlists tab label / panel heading */
	playlists: "Playlists",
	/** Sub-count under the playlists panel heading, singular */
	playlistsCount_one: "{{count}} playlist",
	/** Sub-count under the playlists panel heading, plural */
	playlistsCount_other: "{{count}} playlists",
	/** New-playlist button */
	newPlaylist: "New playlist",
	/** New-playlist dialog title */
	newPlaylistTitle: "New playlist",
	/** New-playlist dialog body */
	newPlaylistBody: "Give your playlist a name.",
	/** Rename-playlist dialog title */
	renamePlaylistTitle: "Rename playlist",
	/** Rename-playlist dialog body */
	renamePlaylistBody: "Choose a new name for this playlist.",
	/** Playlist-name field label, shared by the create/rename dialogs */
	playlistNameLabel: "Name",
	/** Playlist-name field placeholder, shared by the create/rename dialogs */
	playlistNamePlaceholder: "My playlist",
	/** Delete-playlist confirm dialog title */
	deletePlaylistTitle: "Delete playlist",
	/** Delete-playlist confirm dialog body */
	deletePlaylistBody: 'Are you sure you want to delete "{{name}}"? This cannot be undone.',
	/** New-playlist dialog submit button */
	newPlaylistSubmit: "Create",
	/** Rename-playlist row menu item; doubles as the rename dialog's submit button */
	playlistActionRename: "Rename",
	/** Delete-playlist row menu item; doubles as the delete confirm dialog's confirm button */
	playlistActionDelete: "Delete",
	/** Empty-state heading when no playlists exist yet */
	playlistsEmptyTitle: "No playlists yet",
	/** Empty-state body when no playlists exist yet */
	playlistsEmptyBody: "Create a playlist to start organizing your tracks.",
	/** A playlist row whose file failed to download/parse — isolated, shown degraded rather than
	 *  dropping the whole list */
	playlistDegraded: "Couldn't load",
	/** Per-row track count, singular */
	playlistTrackCount_one: "{{count}} track",
	/** Per-row track count, plural */
	playlistTrackCount_other: "{{count}} tracks",
	/** Accessible label for a playlist row's ⋯ menu trigger */
	playlistItemMenuTrigger: "Playlist options",
	/** Play the whole queue/playlist from the top */
	shufflePlay: "Shuffle play",
	/** Add-tracks button on a playlist's detail dialog */
	addTracks: "Add tracks",
	/** Empty-state heading inside an empty playlist's track list */
	playlistTracksEmptyTitle: "No tracks yet",
	/** Empty-state body inside an empty playlist's track list */
	playlistTracksEmptyBody: "Add tracks from your drive to get started.",
	/** Per-row action removing one track from a playlist */
	removeFromPlaylist: "Remove from playlist",
	/** Add-tracks picker dialog title */
	addTracksDialogTitle: "Add tracks",
	/** Add-tracks picker filter placeholder */
	addTracksFilterPlaceholder: "Filter",
	/** Shown next to a row already present in the target playlist */
	alreadyInPlaylist: "Already added",
	/** Add-tracks picker submit button, singular */
	addTracksSubmit_one: "Add {{count}} track",
	/** Add-tracks picker submit button, plural */
	addTracksSubmit_other: "Add {{count}} tracks",
	/** Toast after successfully adding tracks, singular */
	tracksAddedToast_one: "Added {{count}} track",
	/** Toast after successfully adding tracks, plural */
	tracksAddedToast_other: "Added {{count}} tracks"
} as const
