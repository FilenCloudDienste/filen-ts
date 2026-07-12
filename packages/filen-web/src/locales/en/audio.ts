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
	playbackFailed: "Couldn't play this track"
} as const
