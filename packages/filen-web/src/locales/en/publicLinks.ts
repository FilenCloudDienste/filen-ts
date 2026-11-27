// English source catalog — "publicLinks" namespace: the UNAUTHENTICATED public-link viewer at the
// /f/ (file) and /d/ (directory) routes. Flat `as const` object, camelCase keys, no literal '.'/':'
// (this app runs real i18next namespaces with keySeparator/nsSeparator both ON).
export const publicLinks = {
	/** Browser tab title for a /f/ file link — deliberately generic: no shared item's name ever enters the title or any meta tag */
	documentTitleFile: "Shared file",
	/** Browser tab title for a /d/ directory link — same privacy rule as documentTitleFile */
	documentTitleDirectory: "Shared directory",

	/** Invalid/expired surface — title (shared by bad uuid, bad/short key, not-found, network failure) */
	unavailableTitle: "This link is unavailable",
	/** Invalid/expired surface — body; deliberately does not distinguish "doesn't exist" from "expired" */
	unavailableBody: "This link is invalid or has expired.",
	/** Invalid/expired surface — action returning to the app's home */
	back: "Back to Filen",
	/** File view inside a directory link — action returning to that directory's listing */
	backToDirectory: "Back to directory",
	/** Shared error surface — retry the failed resolution */
	retry: "Try again",

	/** Chrome top bar — quiet link to the sign-in page */
	signIn: "Sign in",
	/** Chrome top bar — for a signed-in visitor, in place of the sign-in link and the "Get Filen" CTA: back to their own drive */
	openCloudDrive: "Open Cloud Drive",
	/** Chrome top bar — primary call to action opening filen.io */
	getFilen: "Get Filen",
	/** Chrome — accessible label for the brand mark linking to filen.io */
	homeLabel: "Filen home",
	/** Footer — end-to-end-encryption tagline */
	footerTagline: "Shared securely with end-to-end encryption",
	/** Footer — opens the report-abuse dialog; also the dialog's title */
	reportAbuse: "Report abuse",
	/** Report dialog — label of the reason choices */
	reportReasonLabel: "What's wrong with this link?",
	/** Report dialog — reason */
	reportReasonCopyright: "Copyright infringement",
	/** Report dialog — reason */
	reportReasonStolen: "Stolen data",
	/** Report dialog — reason */
	reportReasonMalware: "Malware",
	/** Report dialog — reason */
	reportReasonCsam: "Child sexual abuse material",
	/** Report dialog — reason */
	reportReasonSpam: "Spam",
	/** Report dialog — reason */
	reportReasonOther: "Other",
	/** Report dialog — email field label */
	reportEmailLabel: "Your email",
	/** Report dialog — email field placeholder */
	reportEmailPlaceholder: "you@example.com",
	/** Report dialog — free-text field label */
	reportDetailsLabel: "Details (optional)",
	/** Report dialog — note on what the report shares, for a link without a password */
	reportNote: "Your report includes this link so our team can review it.",
	/** Report dialog — the same note when the visitor unlocked the link with a password */
	reportNoteWithPassword: "Your report includes this link and its password so our team can review it.",
	/** Report dialog — submit button */
	reportSend: "Send",
	/** Toast after a report was sent */
	reportSent: "Report sent. Thank you.",
	/** Report dialog — the server rejected the submitted fields */
	reportErrorInvalid: "Some details are not valid. Check them and try again.",
	/** Report dialog — the anti-bot check was rejected */
	reportErrorTurnstile: "We couldn't verify you're human. Please try again.",
	/** Report dialog — too many reports from this visitor */
	reportErrorRateLimited: "Too many reports. Try again later.",
	/** Report dialog — server error, network failure or timeout */
	reportErrorServer: "Couldn't send your report. Please try again.",
	/** Report dialog — the anti-bot check could not run */
	reportChallengeFailed: "The security check couldn't load. Check your connection and try again.",

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
	downloadTooLarge: "This file is too large to download here.",
	/** Download — note when a directory's zip outgrows the in-memory download cap on a non-streaming browser */
	downloadDirectoryTooLarge: "This directory is too large to download here.",
	/** Download — note when the zip of the selected files and directories outgrows the in-memory download cap on a non-streaming browser */
	downloadSelectionTooLarge: "This selection is too large to download here.",
	/** Download — follows downloadTooLarge / downloadDirectoryTooLarge / downloadSelectionTooLarge in a browser only (never inside the desktop app) */
	downloadTooLargeAdvice: "Use a Chromium-based browser or the Filen desktop app.",
	/** Download — note when a file or directory download failed, followed by the error's own label */
	downloadFailed: "The download failed.",
	/** Download — in-progress label */
	downloading: "Downloading…",

	/** Directory view — download the whole directory as a zip */
	downloadDirectory: "Download all",
	/** File and directory views, signed-in visitors only — copies the linked file or the directory on screen into their own Cloud Drive (a destination picker, then a progress card) */
	saveToDrive: "Save to Cloud Drive",
	/** File view, signed-in visitors only — opens the linked archive's contents in place of the hero card */
	archiveBrowse: "Browse contents",
	/** File view — closes the archive's contents back to the hero card */
	archiveHideContents: "Hide contents",
	/** File view, signed-in visitors only — extracts the linked archive into their own Cloud Drive (a destination picker, then a progress card) */
	extractToDrive: "Extract to my Cloud Drive",
	/** Directory view, signed-in visitors only — compresses the directory on screen into an archive saved in their own Cloud Drive (the compress dialog) */
	saveAsArchive: "Save as archive",
	/** Directory view — preparing/streaming the zip */
	preparingDownload: "Preparing download…",
	/** Directory view — accessible label of the breadcrumb navigation landmark (the shared directory's levels) */
	publicLinksBreadcrumbLabel: "Location in the shared directory",
	/** Directory view — search box placeholder: searches the directory on screen and every subdirectory below it */
	filterPlaceholder: "Search this directory",
	/** Directory view — empty directory */
	emptyDirectory: "This directory is empty",
	/** Directory view — no items match the active filter */
	noMatches: "No items match your search",
	/** Directory view — under the search box while the first search lists every subdirectory of the directory on screen (a progress bar follows) */
	searchingSubdirectories: "Searching all subdirectories…",
	/** Directory view, selection bar — why Download is unavailable: search results picked from different subdirectories share a name, which one ZIP cannot hold side by side */
	selectionNamesClash: "Some selected items share a name. Download them from their own directories.",
	/** Directory view — row ⋯ and right-click menu entry on a subdirectory: downloads it as one zip */
	downloadAsZip: "Download as ZIP",
	/** Directory view — accessible name of the column header's checkbox that selects every item on screen */
	selectAll: "Select all",
	/** Directory view — selection bar line when only files are selected: how many and their total size, singular */
	selectedSummary_one: "{{count}} selected · {{size}}",
	/** Directory view — selection bar line when only files are selected: how many and their total size, plural */
	selectedSummary_other: "{{count}} selected · {{size}}",
	/** Directory view — item + size summary, singular */
	itemSummary_one: "{{count}} item · {{size}}",
	/** Directory view — item + size summary, plural */
	itemSummary_other: "{{count}} items · {{size}}",
	// Keyboard shortcuts (Settings → Keyboard and the ? dialog)
	/** Keyboard shortcut — downloads the shared file, or the shared directory on screen as a ZIP */
	linkCommandDownload: "Download",
	/** Keyboard shortcut — copies what the link shares into the visitor's own Cloud Drive */
	linkCommandSaveToDrive: "Save to Cloud Drive",
	/** Keyboard shortcut — returns from a file opened inside a shared directory to the directory */
	linkCommandBack: "Back to directory",
	/** Keyboard shortcut — goes up one level inside a shared directory */
	linkCommandUp: "Go up one level",
	/** Keyboard shortcut — focuses the shared directory's filter box */
	linkCommandFilter: "Filter items"
} as const
