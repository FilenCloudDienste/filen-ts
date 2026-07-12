// English source catalog — "publicLinks" namespace: the UNAUTHENTICATED public-link viewer at the
// /f/ (file) and /d/ (directory) routes. Flat `as const` object, camelCase keys, no literal '.'/':'
// (this app runs real i18next namespaces with keySeparator/nsSeparator both ON).
export const publicLinks = {
	/** Shown while the link's metadata is being resolved */
	opening: "Opening link…",
	/** Invalid/expired surface — title (shared by bad uuid, bad/short key, not-found, network failure) */
	unavailableTitle: "This link is unavailable",
	/** Invalid/expired surface — body; deliberately does not distinguish "doesn't exist" from "expired" */
	unavailableBody: "This link is invalid or has expired.",
	/** Invalid/expired surface — action returning to the app's home */
	back: "Back to Filen",
	/** Shared error surface — retry the failed resolution */
	retry: "Try again",

	/** Chrome top bar — quiet link to the sign-in page */
	signIn: "Sign in",
	/** Chrome top bar — primary call to action opening filen.io */
	getFilen: "Get Filen",
	/** Chrome — accessible label for the brand mark linking to filen.io */
	homeLabel: "Filen home",
	/** Footer — end-to-end-encryption tagline */
	footerTagline: "Shared securely with end-to-end encryption",
	/** Footer — report-abuse affordance */
	reportAbuse: "Report abuse",

	/** Password-protected surface — title */
	passwordTitle: "Password required",
	/** Password-protected surface — body */
	passwordBody: "This link is protected with a password.",
	/** Password gate — input label */
	passwordLabel: "Password",
	/** Password gate — input placeholder */
	passwordPlaceholder: "Enter password",
	/** Password gate — submit button */
	passwordSubmit: "Unlock",
	/** Password gate — inline error after a wrong password (input is cleared and refocused) */
	passwordWrong: "Wrong password. Please try again.",

	/** File view — type label shown beside the file's name and size */
	fileLabel: "File",
	/** Directory view — type label shown beside the directory's name */
	directoryLabel: "Directory",
	/** File view — download the file */
	download: "Download",
	/** File view — invoke the inline preview */
	preview: "Preview",
	/** File view — collapse the inline preview back to the hero card */
	hidePreview: "Hide preview",
	/** File view — title when the file is above the inline-preview memory cap */
	previewTooLargeTitle: "Too large to preview",
	/** File view — body when above the preview cap; download stays available */
	previewTooLargeBody: "This file is too large to preview here.",
	/** Download — note when downloads are disabled for the link */
	downloadDisabled: "The owner has disabled downloads for this link.",
	/** Download — note when a file exceeds the in-memory download cap on a non-streaming browser */
	downloadTooLarge: "This file is too large to download in this browser. Use a Chromium-based browser or the Filen desktop app.",
	/** Download — in-progress label */
	downloading: "Downloading…",

	/** Directory view — download the whole directory as a zip */
	downloadDirectory: "Download all",
	/** Directory view — preparing/streaming the zip */
	preparingDownload: "Preparing download…",
	/** Directory view — filter box placeholder */
	filterPlaceholder: "Search this directory",
	/** Directory view — empty directory */
	emptyDirectory: "This directory is empty",
	/** Directory view — no items match the active filter */
	noMatches: "No items match your search",
	/** Directory view — column header for the item name */
	columnName: "Name",
	/** Directory view — column header for the item size */
	columnSize: "Size",
	/** Directory view — column header for the modified date */
	columnModified: "Modified",
	/** Directory view — sort control label */
	sortLabel: "Sort",
	/** Directory view — sort by name */
	sortName: "Name",
	/** Directory view — sort by size */
	sortSize: "Size",
	/** Directory view — sort by modified date */
	sortDate: "Modified",
	/** Directory view — item + size summary, singular */
	itemSummary_one: "{{count}} item · {{size}}",
	/** Directory view — item + size summary, plural */
	itemSummary_other: "{{count}} items · {{size}}"
} as const
