// "preview" namespace, slideshow — the control bar over a running slideshow. Spread into preview.ts; same catalog rules.
export const previewSlideshowBar = {
	/** Preview header — button starting a slideshow over the files of the listing the preview was opened from */
	previewSlideshowStart: "Slideshow",
	/** Slideshow bar — button ending the slideshow */
	previewSlideshowStop: "End slideshow",
	/** Slideshow bar — button continuing a paused slideshow (while it runs the button says Pause) */
	previewSlideshowResume: "Resume",
	/** Slideshow bar — where the slideshow is: {{position}} is the number of the file shown, {{total}} how many files it
	 *  has */
	previewSlideshowPosition: "{{position, number}}/{{total, number}}",
	/** Slideshow bar — name of the menu choosing how long each image stays up */
	previewSlideshowInterval: "Time per image",
	/** Slideshow bar — a time per image, on the menu's button and its choices; {{count}} is a whole number of seconds */
	previewSlideshowIntervalValue_one: "{{count, number}} s",
	previewSlideshowIntervalValue_other: "{{count, number}} s",
	/** Slideshow bar — toggle also showing the files of the directories inside the one the slideshow runs over */
	previewSlideshowSubfolders: "Include subdirectories",
	/** Slideshow bar — spoken name of the group of slideshow controls */
	previewSlideshowControls: "Slideshow controls"
} as const
