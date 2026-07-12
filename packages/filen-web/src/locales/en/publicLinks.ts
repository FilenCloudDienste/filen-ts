// English source catalog — "publicLinks" namespace: the UNAUTHENTICATED public-link viewer at the
// /f/ (file) and /d/ (directory) routes. Flat `as const` object, camelCase keys, no literal '.'/':'
// (this app runs real i18next namespaces with keySeparator/nsSeparator both ON). This first cut is
// the foundation viewer's minimal surface — the richer browse/preview/download copy lands with the
// full viewer UI in the next step.
export const publicLinks = {
	/** Shown while the link's metadata is being resolved */
	opening: "Opening link…",
	/** Invalid/expired surface — title (shared by bad uuid, bad/short key, not-found, network failure) */
	unavailableTitle: "This link is unavailable",
	/** Invalid/expired surface — body; deliberately does not distinguish "doesn't exist" from "expired" */
	unavailableBody: "This link is invalid or has expired.",
	/** Invalid/expired surface — action returning to the app's home */
	back: "Back to Filen",
	/** Password-protected surface — title; the actual password prompt ships with the full viewer */
	passwordTitle: "Password required",
	/** Password-protected surface — body */
	passwordBody: "This link is protected with a password.",
	/** File view — type label shown beside the file's name and size */
	fileLabel: "File",
	/** Directory view — type label shown beside the directory's name */
	directoryLabel: "Directory"
} as const
