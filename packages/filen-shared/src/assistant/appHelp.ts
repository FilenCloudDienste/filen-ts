import { searchTokens } from "./search"

// The settings app_help can explain and open: one row per setting the web and desktop apps' Settings pages show, by the
// locale keys those pages render (namespace:key), so the help text is the text on screen. The apps build their
// search index from it and rank it with rankAppHelp; the eval's fake app reads the same ids and routes and ranks the
// same way.

export type AppHelpSection =
	"account" | "security" | "appearance" | "keyboard" | "office" | "audio" | "assistant" | "advanced" | "billing" | "desktop"

type AppHelpRow = {
	readonly id: string
	readonly section: AppHelpSection
	readonly titleKey: `${string}:${string}`
	readonly descriptionKey: `${string}:${string}`
	// Shown in one app only; the desktop section always is desktop-only.
	readonly platform?: "desktop" | "web"
}

const APP_HELP_ROWS = [
	{
		id: "nickname",
		section: "account",
		titleKey: "settings:settingsNicknameTitle",
		descriptionKey: "settings:settingsNicknameDescription"
	},
	{ id: "email", section: "account", titleKey: "settings:settingsEmailTitle", descriptionKey: "settings:settingsEmailDescription" },
	{
		id: "personalInfo",
		section: "account",
		titleKey: "settings:settingsPersonalTitle",
		descriptionKey: "settings:settingsPersonalDescription"
	},
	{ id: "dataExport", section: "account", titleKey: "settings:settingsGdprTitle", descriptionKey: "settings:settingsGdprDescription" },
	{
		id: "versioning",
		section: "account",
		titleKey: "settings:settingsVersioningTitle",
		descriptionKey: "settings:settingsVersioningDescription"
	},
	{
		id: "loginAlerts",
		section: "account",
		titleKey: "settings:settingsLoginAlertsTitle",
		descriptionKey: "settings:settingsLoginAlertsDescription"
	},
	{
		id: "appearOffline",
		section: "account",
		titleKey: "settings:settingsAppearOfflineTitle",
		descriptionKey: "settings:settingsAppearOfflineDescription"
	},
	{
		id: "deleteAllVersions",
		section: "account",
		titleKey: "settings:settingsDeleteAllVersionsTitle",
		descriptionKey: "settings:settingsDeleteAllVersionsDescription"
	},
	{
		id: "deleteAllItems",
		section: "account",
		titleKey: "settings:settingsDeleteAllItemsTitle",
		descriptionKey: "settings:settingsDeleteAllItemsDescription"
	},
	{
		id: "password",
		section: "security",
		titleKey: "settings:settingsPasswordRowTitle",
		descriptionKey: "auth:changePasswordDescription"
	},
	{ id: "twoFactor", section: "security", titleKey: "auth:twoFactorSectionTitle", descriptionKey: "auth:twoFactorSectionDescription" },
	{
		id: "masterKeys",
		section: "security",
		titleKey: "settings:settingsMasterKeysRowTitle",
		descriptionKey: "auth:exportMasterKeysDescription"
	},
	{ id: "deleteAccount", section: "security", titleKey: "auth:deleteAccountTitle", descriptionKey: "auth:deleteAccountDescription" },
	{ id: "theme", section: "appearance", titleKey: "settings:settingsThemeTitle", descriptionKey: "settings:settingsThemeDescription" },
	{
		id: "language",
		section: "appearance",
		titleKey: "settings:settingsLanguageTitle",
		descriptionKey: "settings:settingsLanguageDescription"
	},
	{
		id: "startScreen",
		section: "appearance",
		titleKey: "settings:settingsStartScreenTitle",
		descriptionKey: "settings:settingsStartScreenDescription"
	},
	{
		id: "defaultNoteType",
		section: "appearance",
		titleKey: "settings:settingsDefaultNoteTypeTitle",
		descriptionKey: "settings:settingsDefaultNoteTypeDescription"
	},
	{
		id: "railOrder",
		section: "appearance",
		titleKey: "settings:settingsRailReset",
		descriptionKey: "settings:settingsRailResetDescription"
	},
	{
		id: "rememberSort",
		section: "appearance",
		titleKey: "settings:settingsRememberSortPerDirectory",
		descriptionKey: "settings:settingsRememberSortPerDirectoryDescription"
	},
	{
		id: "resetSort",
		section: "appearance",
		titleKey: "settings:settingsResetSort",
		descriptionKey: "settings:settingsResetSortDescription"
	},
	{
		id: "rememberView",
		section: "appearance",
		titleKey: "settings:settingsRememberViewPerDirectory",
		descriptionKey: "settings:settingsRememberViewPerDirectoryDescription"
	},
	{
		id: "resetView",
		section: "appearance",
		titleKey: "settings:settingsResetView",
		descriptionKey: "settings:settingsResetViewDescription"
	},
	{ id: "shortcuts", section: "keyboard", titleKey: "settings:settingsSectionKeyboard", descriptionKey: "common:shortcutsDescription" },
	{
		id: "authorName",
		section: "office",
		titleKey: "settings:settingsDocumentsAuthorName",
		descriptionKey: "settings:settingsDocumentsAuthorNameDescription"
	},
	{
		id: "authorInitials",
		section: "office",
		titleKey: "settings:settingsOfficeAuthorInitials",
		descriptionKey: "settings:settingsOfficeAuthorInitialsDescription"
	},
	{
		id: "autosave",
		section: "office",
		titleKey: "settings:settingsDocumentsAutosave",
		descriptionKey: "settings:settingsOfficeAutosaveDescription"
	},
	{
		id: "autosaveDelay",
		section: "office",
		titleKey: "settings:settingsOfficeAutosaveDelay",
		descriptionKey: "settings:settingsOfficeAutosaveDelayDescription"
	},
	{
		id: "spellCheck",
		section: "office",
		titleKey: "settings:settingsOfficeSpellCheck",
		descriptionKey: "settings:settingsOfficeSpellCheckDescription"
	},
	{
		id: "proofingLanguage",
		section: "office",
		titleKey: "settings:settingsOfficeProofingLanguage",
		descriptionKey: "settings:settingsOfficeProofingLanguageDescription"
	},
	{
		id: "ignoreUppercase",
		section: "office",
		titleKey: "settings:settingsOfficeIgnoreUppercase",
		descriptionKey: "settings:settingsOfficeIgnoreUppercaseDescription"
	},
	{
		id: "ignoreNumbers",
		section: "office",
		titleKey: "settings:settingsOfficeIgnoreNumbers",
		descriptionKey: "settings:settingsOfficeIgnoreNumbersDescription"
	},
	{
		id: "ignoreAddresses",
		section: "office",
		titleKey: "settings:settingsOfficeIgnoreAddresses",
		descriptionKey: "settings:settingsOfficeIgnoreAddressesDescription"
	},
	{
		id: "flagRepeated",
		section: "office",
		titleKey: "settings:settingsOfficeFlagRepeated",
		descriptionKey: "settings:settingsOfficeFlagRepeatedDescription"
	},
	{
		id: "dictionary",
		section: "office",
		titleKey: "settings:settingsOfficeDictionary",
		descriptionKey: "settings:settingsOfficeDictionaryDescription"
	},
	{
		id: "regionalFormat",
		section: "office",
		titleKey: "settings:settingsOfficeRegionalFormat",
		descriptionKey: "settings:settingsOfficeRegionalFormatDescription"
	},
	{
		id: "paperSize",
		section: "office",
		titleKey: "settings:settingsOfficePaperSize",
		descriptionKey: "settings:settingsOfficePaperSizeDescription"
	},
	{
		id: "savedSignatures",
		section: "office",
		titleKey: "settings:settingsOfficeSavedSignatures",
		descriptionKey: "settings:settingsOfficeSavedSignaturesDescription"
	},
	{
		id: "markupView",
		section: "office",
		titleKey: "settings:settingsOfficeMarkupView",
		descriptionKey: "settings:settingsOfficeMarkupViewDescription"
	},
	{
		id: "openIn",
		section: "office",
		titleKey: "settings:settingsOfficeOpenIn",
		descriptionKey: "settings:settingsOfficeOpenInDescription"
	},
	{
		id: "formattingMarks",
		section: "office",
		titleKey: "settings:settingsOfficeFormattingMarks",
		descriptionKey: "settings:settingsOfficeFormattingMarksDescription"
	},
	{
		id: "autoQuotes",
		section: "office",
		titleKey: "settings:settingsOfficeAutoQuotes",
		descriptionKey: "settings:settingsOfficeAutoQuotesDescription"
	},
	{
		id: "autoLists",
		section: "office",
		titleKey: "settings:settingsOfficeAutoLists",
		descriptionKey: "settings:settingsOfficeAutoListsDescription"
	},
	{
		id: "ribbonTabsOnly",
		section: "office",
		titleKey: "settings:settingsOfficeRibbonTabsOnly",
		descriptionKey: "settings:settingsOfficeRibbonTabsOnlyDescription"
	},
	{
		id: "slideRail",
		section: "office",
		titleKey: "settings:settingsOfficeSlideRail",
		descriptionKey: "settings:settingsOfficeSlideRailDescription"
	},
	{
		id: "notesPane",
		section: "office",
		titleKey: "settings:settingsOfficeNotesPane",
		descriptionKey: "settings:settingsOfficeNotesPaneDescription"
	},
	{
		id: "smoothTransitions",
		section: "audio",
		titleKey: "audio:smoothTransitions",
		descriptionKey: "settings:settingsAudioSmoothTransitionsDescription"
	},
	{
		id: "manualSkip",
		section: "audio",
		titleKey: "settings:settingsAudioManualSkip",
		descriptionKey: "settings:settingsAudioManualSkipDescription"
	},
	{
		id: "matchLoudness",
		section: "audio",
		titleKey: "settings:settingsAudioMatchLoudness",
		descriptionKey: "settings:settingsAudioMatchLoudnessDescription"
	},
	{
		id: "hideAssistant",
		section: "assistant",
		titleKey: "settings:settingsAssistantHide",
		descriptionKey: "settings:settingsAssistantHideDescription"
	},
	{
		id: "assistantRetention",
		section: "assistant",
		titleKey: "settings:settingsAssistantRetention",
		descriptionKey: "settings:settingsAssistantRetentionDescription"
	},
	{
		id: "transfers",
		section: "advanced",
		titleKey: "settings:settingsAdvancedTransferTitle",
		descriptionKey: "settings:settingsAdvancedTransferDescription"
	},
	{
		id: "transferChunks",
		section: "advanced",
		titleKey: "settings:settingsAdvancedTransferChunks",
		descriptionKey: "settings:settingsAdvancedTransferChunksDescription"
	},
	{
		id: "archiveMemory",
		section: "advanced",
		titleKey: "settings:settingsAdvancedArchiveMemory",
		descriptionKey: "settings:settingsAdvancedArchiveMemoryDescription"
	},
	{
		id: "heicToJpg",
		section: "advanced",
		titleKey: "settings:settingsConvertHeicToJpg",
		descriptionKey: "settings:settingsConvertHeicToJpgDescription"
	},
	{
		id: "dotFilen",
		section: "advanced",
		titleKey: "settings:settingsShowDotFilen",
		descriptionKey: "settings:settingsShowDotFilenDescription"
	},
	{
		id: "cacheThumbnails",
		section: "advanced",
		titleKey: "settings:storageThumbnails",
		descriptionKey: "settings:storageThumbnailsDescription"
	},
	{ id: "cacheVideos", section: "advanced", titleKey: "settings:storageVideos", descriptionKey: "settings:storageVideosDescription" },
	{ id: "cacheMusic", section: "advanced", titleKey: "settings:storageMusic", descriptionKey: "settings:storageMusicDescription" },
	{
		id: "cacheQuery",
		section: "advanced",
		titleKey: "settings:storageQueryCache",
		descriptionKey: "settings:storageQueryCacheDescription"
	},
	{ id: "cacheModel", section: "advanced", titleKey: "settings:storageModel", descriptionKey: "settings:storageModelDescription" },
	{
		id: "cacheBrowser",
		section: "advanced",
		titleKey: "settings:storageBrowserCache",
		descriptionKey: "settings:storageBrowserCacheDescription",
		platform: "desktop"
	},
	{
		id: "cacheNetworkDrive",
		section: "advanced",
		titleKey: "settings:storageNetworkDrive",
		descriptionKey: "settings:storageNetworkDriveDescription",
		platform: "desktop"
	},
	{ id: "cacheOther", section: "advanced", titleKey: "settings:storageOther", descriptionKey: "settings:storageOtherDescription" },
	{ id: "logs", section: "advanced", titleKey: "settings:settingsLogsTitle", descriptionKey: "settings:settingsLogsDescription" },
	{
		id: "thirdPartyNotices",
		section: "advanced",
		titleKey: "settings:settingsThirdPartyNoticesTitle",
		descriptionKey: "settings:settingsThirdPartyNoticesDescription"
	},
	{
		id: "subscriptions",
		section: "billing",
		titleKey: "settings:settingsBillingSubscriptionsTitle",
		descriptionKey: "settings:settingsBillingSubscriptionsDescription"
	},
	{
		id: "invoices",
		section: "billing",
		titleKey: "settings:settingsBillingInvoicesTitle",
		descriptionKey: "settings:settingsBillingInvoicesDescription"
	},
	{
		id: "launchAtLogin",
		section: "desktop",
		titleKey: "settings:settingsDesktopLaunchAtLogin",
		descriptionKey: "settings:settingsDesktopLaunchAtLoginDescription"
	},
	{
		id: "startMinimized",
		section: "desktop",
		titleKey: "settings:settingsDesktopStartMinimized",
		descriptionKey: "settings:settingsDesktopStartMinimizedDescription"
	},
	{
		id: "minimizeToTray",
		section: "desktop",
		titleKey: "settings:settingsDesktopMinimizeToTray",
		descriptionKey: "settings:settingsDesktopMinimizeToTrayDescription"
	},
	{
		id: "chatNotifications",
		section: "desktop",
		titleKey: "settings:settingsDesktopChatNotifications",
		descriptionKey: "settings:settingsDesktopChatNotificationsDescription"
	},
	{
		id: "contactNotifications",
		section: "desktop",
		titleKey: "settings:settingsDesktopContactNotifications",
		descriptionKey: "settings:settingsDesktopContactNotificationsDescription"
	},
	{
		id: "syncNotifications",
		section: "desktop",
		titleKey: "settings:settingsDesktopSyncNotifications",
		descriptionKey: "settings:settingsDesktopSyncNotificationsDescription"
	},
	{
		id: "notificationSound",
		section: "desktop",
		titleKey: "settings:settingsDesktopNotificationSound",
		descriptionKey: "settings:settingsDesktopNotificationSoundDescription"
	},
	{ id: "appLockPin", section: "desktop", titleKey: "desktop:settingsLockPin", descriptionKey: "desktop:settingsLockPinDescription" },
	{
		id: "appLockAfter",
		section: "desktop",
		titleKey: "settings:settingsDesktopLockAfter",
		descriptionKey: "settings:settingsDesktopLockAfterDescription"
	},
	{ id: "lockNow", section: "desktop", titleKey: "desktop:settingsLockNow", descriptionKey: "desktop:settingsLockNowDescription" },
	{
		id: "downloadLocation",
		section: "desktop",
		titleKey: "settings:settingsDesktopDownloadLocation",
		descriptionKey: "settings:settingsDesktopDownloadLocationDescription"
	},
	{
		id: "logsExport",
		section: "desktop",
		titleKey: "desktop:settingsLogsExport",
		descriptionKey: "desktop:settingsLogsExportDescription"
	}
] as const satisfies readonly AppHelpRow[]

export type AppHelpId = (typeof APP_HELP_ROWS)[number]["id"]

export type AppHelpEntry = Omit<AppHelpRow, "id"> & {
	readonly id: AppHelpId
	// The open_route section showing the row.
	readonly route: `settings_${AppHelpSection}`
	// The DOM id of the row on that page, which a deep link scrolls to.
	readonly anchor: string
}

// The row's DOM id: namespaced, so it never meets a control's own id.
export function appHelpAnchor(id: AppHelpId): string {
	return `help-${id}`
}

export const APP_HELP: readonly AppHelpEntry[] = APP_HELP_ROWS.map((row: AppHelpRow & { readonly id: AppHelpId }): AppHelpEntry => ({
	...row,
	...(row.section === "desktop" ? { platform: "desktop" } : {}),
	route: `settings_${row.section}`,
	anchor: appHelpAnchor(row.id)
}))

// How many rows one app_help call returns.
export const APP_HELP_RESULTS = 5

export const APP_HELP_NO_MATCH_NOTE =
	"No setting matches these words. Answer from what you know about the app only if you are sure; otherwise say you could not find it."

// A keyboard shortcut result's keys when the shortcut has none.
export const APP_HELP_UNBOUND = "not set"

// A row's words in one language, its title's and its description's, folded as a query's are.
export type AppHelpWords = { readonly title: readonly string[]; readonly description: readonly string[] }

export function appHelpWords(title: string, description: string): AppHelpWords {
	return { title: searchTokens(title), description: searchTokens(description) }
}

const UNSPACED_WORD = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Thai}]/u

// A query word finds a row word it begins ("notif" finds "notifications"), its plural folded ("passwords" finds
// "password"); in a script written without spaces, where the two sides may be cut into words differently, anywhere
// in one.
function wordMatches(words: readonly string[], token: string): boolean {
	if (UNSPACED_WORD.test(token)) {
		return words.some(word => word.includes(token) || (UNSPACED_WORD.test(word) && token.includes(word)))
	}

	const stem =
		token.length > 4 && token.endsWith("es") ? token.slice(0, -2) : token.length > 3 && token.endsWith("s") ? token.slice(0, -1) : token

	return words.some(word => word.startsWith(stem))
}

// The rows that hold the most of the query's words, best first, at most APP_HELP_RESULTS; ties keep the registry's
// order. A word in the title counts double, and a row scores its best language (the app's or English). A word of one
// or two Latin letters or digits matches too much to count. Among rows that score alike, the `preferred` ones (a
// shortcut of the screen the user is on, where several screens name one alike: Rename) come first.
export function rankAppHelp<T>(
	rows: readonly T[],
	query: string,
	words: (row: T) => readonly AppHelpWords[],
	preferred: (row: T) => boolean = () => false
): T[] {
	const tokens = [...new Set(searchTokens(query))].filter(token => UNSPACED_WORD.test(token) || token.length > 2)

	if (tokens.length === 0) {
		return []
	}

	return rows
		.map((row, index) => ({
			row,
			index,
			preferred: preferred(row),
			score: Math.max(
				0,
				...words(row).map(
					language =>
						tokens.filter(token => wordMatches(language.title, token)).length * 2 +
						tokens.filter(token => wordMatches(language.description, token)).length
				)
			)
		}))
		.filter(scored => scored.score > 0)
		.sort((a, b) => b.score - a.score || Number(b.preferred) - Number(a.preferred) || a.index - b.index)
		.slice(0, APP_HELP_RESULTS)
		.map(scored => scored.row)
}
