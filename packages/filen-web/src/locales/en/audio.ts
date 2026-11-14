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
	/** Name of the feature that blends the end of each track into the start of the next one (a crossfade; it never
	 *  picks songs). The player's toggle, its settings card and its switch */
	smoothTransitions: "Smooth transitions",
	/** Tooltip of the player's toggle for blending each track into the next (a crossfade, never song picking), with
	 *  the blend length; {{count}} is a whole number of seconds */
	smoothTransitionsTooltip_one: "Smooth transitions · {{count}} s",
	smoothTransitionsTooltip_other: "Smooth transitions · {{count}} s",
	/** Why blending each track into the next (a crossfade, never song picking) can't be used: this device isn't
	 *  supported yet */
	smoothTransitionsUnavailableDevice: "Not available on this device yet.",
	/** Why blending each track into the next (a crossfade, never song picking) stopped: the device's audio mixer failed,
	 *  so tracks switch at once until the page is reloaded */
	smoothTransitionsUnavailableDegraded: "Off until you reload: this device stopped the audio mixer.",
	/** Why blending each track into the next (a crossfade, never song picking) can't be used: Safari loaded this page
	 *  without the app's background service, so its tracks can't be mixed until the page is reloaded */
	smoothTransitionsUnavailableSource: "Safari can't blend tracks until you reload this page.",

	// ── Now-playing surface ────────────────────────────────────────────────
	/** Shown in place of a track name before anything is queued */
	nothingPlaying: "Nothing playing",
	/** Fallback when a track has no metadata artist */
	unknownArtist: "Unknown artist",
	/** Accessible label for the whole player bar landmark */
	playerLabel: "Audio player",
	/** Accessible label for the queue toggle button */
	showQueue: "Show queue",
	/** Empty a full queue and hide the player */
	clearQueue: "Clear queue",
	/** Per-row action removing one track from the queue */
	removeFromQueue: "Remove from queue",
	/** Sub-count under the panel heading, singular */
	queueCount_one: "{{count}} track",
	/** Sub-count under the panel heading, plural */
	queueCount_other: "{{count}} tracks",

	// ── Unplayable formats (toast + the bar's error line) ──────────────────
	/** The player skipped a track because the browser can't decode its format; {{name}} is the file name */
	formatSkipped: "Skipped {{name}} — its format can't be played here",
	/** Playback stopped on a track because the browser can't decode its format (nothing left to skip to, or paused); {{name}} is the file name */
	formatStopped: "Couldn't play {{name}} — its format can't be played here",
	/** One notice covering several skipped tracks whose format the browser can't decode, singular */
	formatSkippedCount_one: "Skipped {{count}} track — its format can't be played here",
	/** One notice covering several skipped tracks whose format the browser can't decode, plural */
	formatSkippedCount_other: "Skipped {{count}} tracks — their format can't be played here",
	/** One notice covering several tracks whose format the browser can't decode, after which playback stopped, singular */
	formatStoppedCount_one: "Couldn't play {{count}} track — its format can't be played here",
	/** One notice covering several tracks whose format the browser can't decode, after which playback stopped, plural */
	formatStoppedCount_other: "Couldn't play {{count}} tracks — their format can't be played here",

	// ── Keyboard-shortcut descriptions (keymap registry) ───────────────────
	/** Toggle play/pause via keyboard */
	commandPlayPause: "Play / pause",
	/** Skip to next track via keyboard */
	commandNext: "Next track",
	/** Skip to previous track via keyboard */
	commandPrevious: "Previous track",
	/** Seek the playing track back via keyboard */
	commandSeekBack: "Back 10 seconds",
	/** Seek the playing track forward via keyboard */
	commandSeekForward: "Forward 10 seconds",
	/** Raise the volume via keyboard */
	commandVolumeUp: "Volume up",
	/** Lower the volume via keyboard */
	commandVolumeDown: "Volume down",
	/** Mute or unmute via keyboard */
	commandMute: "Mute or unmute",
	/** Turn shuffle on or off via keyboard */
	commandShuffle: "Shuffle on or off",
	/** Switch the repeat mode (off, all, one) via keyboard */
	commandLoop: "Change repeat mode",
	/** Turn on or off blending each track into the next (a crossfade, never song picking) via keyboard */
	commandSmoothTransitions: "Smooth transitions on or off",
	/** Show or hide the play queue via keyboard */
	commandToggleQueue: "Show or hide the queue",

	// ── Playlists ────────────────────────────────────────────────────────────
	/** New-playlist control in the playlists sidebar header (its accessible name) */
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
	/** Empty-state action creating the first playlist (distinct from the sidebar's "New playlist" control) */
	playlistsEmptyAction: "Create playlist",
	/** Small label above a playlist's name in its page header */
	playlistEyebrow: "Playlist",
	/** Last-modified part of a playlist's page-header meta line; `time` is a relative label ("2 hours ago") */
	playlistUpdated: "Updated {{time}}",
	/** A playlist row whose file failed to download/parse — isolated, shown degraded rather than
	 *  dropping the whole list */
	playlistDegraded: "Couldn't load",
	/** Per-row track count, singular */
	playlistTrackCount_one: "{{count}} track",
	/** Per-row track count, plural */
	playlistTrackCount_other: "{{count}} tracks",
	/** Accessible label for a playlist row's ⋯ menu trigger */
	playlistItemMenuTrigger: "Playlist options",
	playlistsSidebarResize: "Resize sidebar",
	/** Play the whole queue/playlist from the top */
	shufflePlay: "Shuffle play",
	/** Add-tracks button in a playlist's page header */
	addTracks: "Add tracks",
	/** Empty-state heading inside an empty playlist's track list */
	playlistTracksEmptyTitle: "No tracks yet",
	/** Empty-state body inside an empty playlist's track list */
	playlistTracksEmptyBody: "Add tracks from your drive to get started.",
	/** Per-row action removing one track from a playlist */
	removeFromPlaylist: "Remove from playlist",
	/** Track-table column header: position in the playlist */
	trackColumnNumber: "#",
	/** Track-table column header: track title (with its cover and artist) */
	trackColumnTitle: "Title",
	/** Track-table column header: album name from the track's tags */
	trackColumnAlbum: "Album",
	/** Track-table column header: track length */
	trackColumnDuration: "Duration",
	/** Track-table column header: file size */
	trackColumnSize: "Size",
	/** Track-table column header for the per-row actions (visually hidden) */
	trackColumnActions: "Actions",
	/** Screen-reader text replacing a track's position while it is the one playing */
	trackNowPlaying: "Now playing",
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
	tracksAddedToast_other: "Added {{count}} tracks",

	// ── Activity toasts (lib/activity) ──────────────────────────────────────
	// The running line of an action and how it ended, in the toast that shows it. `_one` names the one
	// track, `_other` counts them; a partial result counts the ones that succeeded.
	/** Activity toast — moving a track within a playlist by drag running; one item named ({{name}}) */
	playlistTrackMoveRunning_one: "Moving {{name}}",
	/** Activity toast — moving a track within a playlist by drag running; {{count}} items */
	playlistTrackMoveRunning_other: "Moving {{count}} tracks",
	/** Activity toast — moving a track within a playlist by drag finished; one item named ({{name}}) */
	playlistTrackMoveDone_one: "Moved {{name}}",
	/** Activity toast — moving a track within a playlist by drag finished; {{count}} items */
	playlistTrackMoveDone_other: "Moved {{count}} tracks",
	/** Activity toast — moving a track within a playlist by drag failed for every item; one item named ({{name}}) */
	playlistTrackMoveFailed_one: "Couldn't move {{name}}",
	/** Activity toast — moving a track within a playlist by drag failed for every item; {{count}} items */
	playlistTrackMoveFailed_other: "Couldn't move {{count}} tracks",
	/** Activity toast — moving a track within a playlist by drag partly failed; {{count}} succeeded, {{failed}} failed */
	playlistTrackMovePartial_one: "Moved {{count}} track, {{failed}} failed",
	/** Activity toast — moving a track within a playlist by drag partly failed; {{count}} succeeded, {{failed}} failed */
	playlistTrackMovePartial_other: "Moved {{count}} tracks, {{failed}} failed",

	// Keyboard shortcuts (Settings → Keyboard, Playlists group)
	/** Keyboard shortcut action — renames the playlist the focused sidebar row names, else the one on screen */
	playlistsCommandRename: "Rename playlist",
	/** Keyboard shortcut action — deletes the playlist the focused sidebar row names, else the one on screen (asks first) */
	playlistsCommandDelete: "Delete playlist",
	/** Keyboard shortcut action — plays the playlist the focused sidebar row names, else the one on screen, from its first track */
	playlistsCommandPlay: "Play playlist",
	/** Keyboard shortcut action — plays the playlist the focused sidebar row names, else the one on screen, in random order */
	playlistsCommandShuffle: "Shuffle play playlist",
	/** Keyboard shortcut action — moves the focused track one place up in the playlist */
	playlistsCommandMoveTrackUp: "Move track up",
	/** Keyboard shortcut action — moves the focused track one place down in the playlist */
	playlistsCommandMoveTrackDown: "Move track down",
	/** Keyboard shortcut action — in the Add tracks dialog, selects every audio file listed in the current directory */
	playlistsCommandPickerSelectAll: "Select all listed tracks",
	/** Keyboard shortcut action — in the Add tracks dialog, moves the cursor into the filter box */
	playlistsCommandPickerFilter: "Filter tracks",
	/** Keyboard shortcut action — in the Add tracks dialog, adds the selected tracks to the playlist */
	playlistsCommandPickerConfirm: "Add selected tracks",
	/** Keyboard shortcuts — where the track-move shortcuts work */
	playlistsHintTrackRow: "On a focused track",
	/** Keyboard shortcuts — where the Add tracks dialog's shortcuts work */
	playlistsHintPicker: "In the Add tracks dialog"
} as const
