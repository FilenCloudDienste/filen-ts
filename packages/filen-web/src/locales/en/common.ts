// English source catalog — "common" namespace (T7 rev 1: the minimal boot/theme vocabulary this
// slice needs; feature catalogs land per-area as later slices ship, mirroring filen-mobile's
// per-area-file convention — see docs/research/mobile/i18n-theme.md). Flat `as const` object:
// i18next's default `keySeparator` ('.') and `nsSeparator` (':') stay ON here (unlike mobile,
// which disables both to run one flat namespace) — this app declares TWO real namespaces
// ("common", "errors"), so keys must avoid literal '.' or ':' characters.
export const common = {
	appName: "Filen",
	loading: "Loading…",
	ephemeralSession: "Ephemeral session",
	bootDownloading: "Downloading Filen…",
	noCoiTitle: "Unable to start Filen securely",
	noCoiBody:
		"Your browser did not load this page with the isolation features Filen requires. Try reloading the page, or contact support if the problem continues.",
	toggleTheme: "Toggle theme"
} as const
