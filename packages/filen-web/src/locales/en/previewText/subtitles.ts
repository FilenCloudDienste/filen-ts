// "preview" namespace, text family — a subtitle file's cue table. Spread into preview.ts; same catalog rules.
export const previewTextSubtitles = {
	/** Subtitle preview — the view switch's group name (Cues | Source) */
	previewSubtitlesView: "Subtitle view",
	/** Subtitle preview — the view switch's option that shows the cue table */
	previewSubtitlesCues: "Cues",
	/** Subtitle preview — summary line; {{format}} is the format (SRT, VTT…), {{count}} the number of cues, {{encoding}} the text encoding, {{span}} the time the last cue ends (01:42:10) */
	previewSubtitlesSummary_one: "{{format}} · {{count}} cue · {{encoding}} · {{span}}",
	/** Subtitle preview — summary line; {{format}} is the format (SRT, VTT…), {{count}} the number of cues, {{encoding}} the text encoding, {{span}} the time the last cue ends (01:42:10) */
	previewSubtitlesSummary_other: "{{format}} · {{count}} cues · {{encoding}} · {{span}}",
	/** Subtitle preview — the cue filter field's placeholder and accessible name */
	previewSubtitlesFind: "Find in cues",
	/** Subtitle preview — shown while a filter is applied; {{count}} matching cues */
	previewSubtitlesMatches_one: "{{count}} match",
	/** Subtitle preview — shown while a filter is applied; {{count}} matching cues */
	previewSubtitlesMatches_other: "{{count}} matches",
	/** Subtitle preview — the cue table's accessible name */
	previewSubtitlesTable: "Cues",
	/** Subtitle preview — column: the cue's number */
	previewSubtitlesNumber: "#",
	/** Subtitle preview — column: when the cue starts */
	previewSubtitlesStart: "Start",
	/** Subtitle preview — column: when the cue ends */
	previewSubtitlesEnd: "End",
	/** Subtitle preview — column: how long the cue shows */
	previewSubtitlesDuration: "Duration",
	/** Subtitle preview — a cue's duration in seconds, one decimal; {{seconds}} is already formatted */
	previewSubtitlesSeconds: "{{seconds}} s",
	/** Subtitle preview — column: the cue's text */
	previewSubtitlesText: "Text",
	/** Subtitle preview — the file is in no format the cue table reads; its source still opens */
	previewSubtitlesUnreadable: "No cues could be read from this file. Switch to Source to see its text.",
	/** Subtitle preview — reading the cues failed */
	previewSubtitlesFailed: "The cues could not be read."
}
