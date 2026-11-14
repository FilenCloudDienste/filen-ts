// "settings" namespace — Settings > Audio: how the audio player moves from one track to the next. Spread into
// settings.ts; same catalog rules (flat, camelCase, keys unique across the namespace's files, no literal '.' or ':').
// The feature's name, and why it can be unavailable, are the audio namespace's (smoothTransitions*).
export const settingsAudio = {
	/** Settings sidebar — Audio section nav label and that section's page heading (the audio player's settings) */
	settingsSectionAudio: "Audio",
	/** Settings > Audio — description of the switch that blends the end of each track into the start of the next one
	 *  (a crossfade; it never picks songs) */
	settingsAudioSmoothTransitionsDescription: "Blend the end of each track into the next one.",
	/** Settings > Audio — row label: how long the end of one track and the start of the next play together while one
	 *  blends into the other (a crossfade, never song picking) */
	settingsAudioFadeLength: "Crossfade length",
	/** Settings > Audio — the crossfade length, as the row's description and as the slider's spoken value; {{count}}
	 *  is a whole number of seconds */
	settingsAudioFadeLengthValue_one: "{{count}} second",
	settingsAudioFadeLengthValue_other: "{{count}} seconds",
	/** Settings > Audio — a crossfade length choice on phones, abbreviated; {{count}} is a whole number of seconds */
	settingsAudioFadeLengthShort_one: "{{count}} s",
	settingsAudioFadeLengthShort_other: "{{count}} s",
	/** Settings > Audio — crossfade length choice on phones that opens a slider for any other length */
	settingsAudioFadeLengthCustom: "Custom",
	/** Settings > Audio — button closing the custom crossfade length dialog */
	settingsAudioFadeLengthDone: "Done",
	/** Settings > Audio — row label: what happens when the user skips to another track while tracks blend into each
	 *  other (a crossfade, never song picking) */
	settingsAudioManualSkip: "When you skip",
	/** Settings > Audio — "When you skip" row description */
	settingsAudioManualSkipDescription: "Next, previous or a track you pick.",
	/** Settings > Audio — "When you skip" choice: the picked track starts right away */
	settingsAudioManualSkipCut: "Switch at once",
	/** Settings > Audio — "When you skip" choice: the playing track fades briefly into the picked one */
	settingsAudioManualSkipFade: "Short fade",
	/** Settings > Audio — switch: play tracks at a similar volume while they blend into each other (a crossfade, never
	 *  song picking) */
	settingsAudioMatchLoudness: "Match loudness",
	/** Settings > Audio — match loudness description; ReplayGain is the name of the loudness tags in audio files */
	settingsAudioMatchLoudnessDescription: "Uses ReplayGain; untagged tracks play 6 dB quieter."
} as const
