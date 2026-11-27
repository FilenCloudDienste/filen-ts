import { appHelpWords, type AppHelpEntry, type AppHelpSection, type AppHelpWords } from "@filen/shared/assistant"
import { i18n } from "@/lib/i18n"
import type { AppKey } from "@/lib/i18n/appKey"
import { isDesktopApp } from "@/lib/desktop"

// The app's reading of the app_help registry (@filen/shared/assistant appHelp.ts), shared by the assistant's help tool
// and the Settings search.

// The Settings sidebar's label of each section.
export const APP_HELP_SECTION_LABELS: Readonly<Record<AppHelpSection, AppKey>> = {
	account: "settings:settingsSectionAccount",
	security: "settings:settingsSectionSecurity",
	appearance: "settings:settingsSectionAppearance",
	keyboard: "settings:settingsSectionKeyboard",
	office: "settings:settingsSectionOffice",
	audio: "settings:settingsSectionAudio",
	assistant: "settings:settingsSectionAssistant",
	advanced: "settings:settingsSectionAdvanced",
	billing: "settings:settingsSectionBilling",
	desktop: "settings:settingsSectionDesktop"
}

// The rows of this app: the desktop section and desktop-only rows in the desktop app, web-only rows on the web.
export function appHelpShownHere(entry: AppHelpEntry): boolean {
	return entry.platform === undefined || entry.platform === (isDesktopApp() ? "desktop" : "web")
}

// The registry types its keys as plain "namespace:key" strings, which i18n.t takes with a defaultValue; the registry
// drift test (appHelpRegistry.test.ts) pins that every one exists.

// For searching only, in `language` (the app's when undefined): a figure's placeholder is no word of it.
export function appHelpSearchText(key: string, language?: string): string {
	return i18n.t(key, { defaultValue: "", count: 2, ...(language === undefined ? {} : { lng: language }) }).replace(/\{\{[^}]*\}\}/g, " ")
}

// The languages a row is searched in: the app's, and English too.
export function appHelpLanguages(language: string): readonly (string | undefined)[] {
	return language === "en" ? [undefined] : [undefined, "en"]
}

// A setting's words in each of `languages`, its title's and its description's.
export function appHelpEntryWords(entry: AppHelpEntry, languages: readonly (string | undefined)[]): AppHelpWords[] {
	return languages.map(lng => appHelpWords(appHelpSearchText(entry.titleKey, lng), appHelpSearchText(entry.descriptionKey, lng)))
}
