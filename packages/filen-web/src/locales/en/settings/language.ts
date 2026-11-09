import { DESKTOP_SHELL_STRINGS } from "@filen/shared/desktopShellStrings"

// "settings" namespace — the language picker (Appearance), and the desktop shell's own
// text (menu, tray, notifications and dialogs main shows; its English and the context of each key live in
// @filen/shared/desktopShellStrings). Spread into settings.ts; same catalog rules (flat, camelCase, keys unique
// across the namespace's files, no literal '.' or ':').
export const settingsLanguage = {
	...DESKTOP_SHELL_STRINGS,
	/** Appearance → General — label of the select that picks the app's language */
	settingsLanguageTitle: "Language",
	/** Appearance → General — description under the language select; dates and numbers keep the browser's format */
	settingsLanguageDescription: "The language of the app. Dates and numbers follow your browser's region.",
	/** Appearance → General — language select option that follows the browser's preferred languages instead of a fixed pick */
	settingsLanguageSystem: "Browser default"
} as const
