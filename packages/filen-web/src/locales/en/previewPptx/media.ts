// "preview" namespace, presentations: video and audio on slides (Insert ▸ Media, the Video and Audio tabs, playing a
// medium on the slide and in the show). Spread into preview.ts; same catalog rules.
export const previewPptxMedia = {
	/** Presentation editor — Insert tab group holding the Video and Audio commands */
	previewPptxMediaGroup: "Media",
	/** Presentation editor — Insert ▸ Media: inserts a video file into the slide */
	previewPptxInsertVideo: "Video",
	/** Presentation editor — Insert ▸ Media: inserts an audio file into the slide */
	previewPptxInsertAudio: "Audio",
	/** Presentation editor — Insert ▸ Video/Audio menu item: a file from this computer or phone */
	previewPptxMediaFromDevice: "From this device…",
	/** Presentation editor — Insert ▸ Video/Audio menu item: a file from the user's Filen drive */
	previewPptxMediaFromDrive: "From Filen…",
	/** Presentation editor — title of the dialog picking a video from the drive */
	previewPptxVideoDriveTitle: "Insert a video",
	/** Presentation editor — description of the dialog picking a video from the drive */
	previewPptxVideoDriveDescription: "Choose a video from your drive. It is stored in the presentation when you save.",
	/** Presentation editor — title of the dialog picking an audio file from the drive */
	previewPptxAudioDriveTitle: "Insert audio",
	/** Presentation editor — description of the dialog picking an audio file from the drive */
	previewPptxAudioDriveDescription: "Choose an audio file from your drive. It is stored in the presentation when you save.",
	/** Presentation editor — toast while a large media file is read before it goes on the slide */
	previewPptxMediaReading: "Adding {{name}}…",
	/** Presentation editor — error toast: the chosen file is not a video or audio file */
	previewPptxMediaNotMedia: "This file isn't a video or audio file.",
	/** Presentation editor — error toast: the chosen media file is over the size limit (4 GB) */
	previewPptxMediaTooLarge: "Media files can be at most 4 GB.",
	/** Presentation editor — error toast: the media file could not be read or inserted */
	previewPptxMediaFailed: "The media couldn't be added.",
	/** Presentation editor — Video/Audio tab group: how the medium plays in the slide show */
	previewPptxPlaybackGroup: "Playback",
	/** Presentation editor — Video/Audio tab group: previewing the medium on the slide */
	previewPptxPreviewGroup: "Preview",
	/** Presentation editor — button that plays the selected medium on the slide */
	previewPptxMediaPlay: "Play",
	/** Presentation editor — button that pauses the selected medium on the slide */
	previewPptxMediaPause: "Pause",
	/** Presentation editor — Playback group menu: how loud the medium plays */
	previewPptxMediaVolume: "Volume",
	/** Presentation editor — Volume menu item */
	previewPptxMediaVolumeLow: "Low",
	/** Presentation editor — Volume menu item */
	previewPptxMediaVolumeMedium: "Medium",
	/** Presentation editor — Volume menu item */
	previewPptxMediaVolumeHigh: "High",
	/** Presentation editor — Volume menu item: no sound */
	previewPptxMediaVolumeMute: "Mute",
	/** Presentation editor — Playback toggle: the medium is hidden in the show until it plays */
	previewPptxMediaHideWhenStopped: "Hide while not playing",
	/** Presentation editor — Playback toggle: the medium starts again when it ends, until stopped */
	previewPptxMediaLoop: "Loop until stopped",
	/** Presentation editor — Playback toggle (video only): the video fills the screen while it plays */
	previewPptxMediaFullScreen: "Play full screen",
	/** Presentation editor — Video tab group: the picture shown before the video plays */
	previewPptxPosterGroup: "Poster frame",
	/** Presentation editor — Poster frame button: use a picture from this device as the poster */
	previewPptxPosterFromFile: "Image from file…",
	/** Presentation editor — error toast: the chosen poster picture cannot be used */
	previewPptxPosterFailed: "That picture can't be used as the poster.",
	/** Presentation slide and show — chip over a video while it is prepared for playback; {{percent}} is a number */
	previewPptxMediaPreparing: "Preparing media… {{percent}}%",
	/** Presentation slide and show — chip over a video while it is prepared for playback, before progress is known */
	previewPptxMediaPreparingStart: "Preparing media…",
	/** Presentation slide and show — chip over a medium this browser cannot play */
	previewPptxMediaUnplayable: "This media can't be played in this browser.",
	/** Presentation slide and show — chip over a medium whose data could not be read */
	previewPptxMediaUnavailable: "This media isn't available.",
	/** Presentation slide and show — button over a medium that lives on the web: opens it in a new tab */
	previewPptxMediaOpenLink: "Open link",
	/** Presentation slide and show — chip over a medium stored outside the presentation that is not on the web */
	previewPptxMediaLinkedFile: "This media is stored outside the presentation.",
	/** Presentation editor — accessible name of the play button over a video on the slide */
	previewPptxMediaPlayNamed: "Play {{name}}",
	/** Presentation editor — accessible name of the pause button over a video on the slide */
	previewPptxMediaPauseNamed: "Pause {{name}}"
}
