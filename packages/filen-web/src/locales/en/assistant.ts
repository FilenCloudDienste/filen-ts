// English source catalog — "assistant" namespace: the on-device assistant panel — its setup and download,
// the conversation, a turn's progress steps, confirmation cards and the composer. Same typed-catalog rules as every
// other namespace: flat `as const` object, camelCase keys, no literal '.' or ':' (real i18next
// namespaces, keySeparator/nsSeparator both ON). "directory" never "folder".
export const assistant = {
	// ── Panel chrome ─────────────────────────────────────────────────────────
	/** Panel heading and the accessible name of the panel landmark and its narrow-screen drawer */
	assistantTitle: "Assistant",
	/** Header button — closes the panel */
	assistantClose: "Close assistant",
	/** Header button — clears the conversation and starts over */
	assistantNewConversation: "New conversation",
	/** Header button — opens the overflow menu */
	assistantMoreOptions: "More options",
	/** Overflow menu — deletes the downloaded model from this device */
	assistantRemoveModel: "Remove downloaded model",
	/** Remove-model confirmation — title */
	assistantRemoveModelTitle: "Remove the downloaded model?",
	/** Remove-model confirmation — body; frees disk space, can be downloaded again */
	assistantRemoveModelBody: "This frees {{size}} on this device. You can download the model again at any time.",
	/** Remove-model confirmation — confirm button */
	assistantRemoveModelConfirm: "Remove",
	/** Toast — removing the model failed */
	assistantRemoveModelFailed: "Couldn't remove the downloaded model",
	/** Drag handle on the panel's left edge — accessible name of the separator */
	assistantResize: "Resize assistant panel",

	// ── Conversation history ─────────────────────────────────────────────────
	/** Header toggle — shows the saved conversations in place of the current one */
	assistantHistory: "Conversation history",
	/** History list — accessible name of the list of saved conversations */
	assistantHistoryListLabel: "Saved conversations",
	/** History group header — last active today */
	assistantHistoryToday: "Today",
	/** History group header — last active yesterday */
	assistantHistoryYesterday: "Yesterday",
	/** History group header — last active within the 7 days before yesterday */
	assistantHistoryPrevious7Days: "Previous 7 days",
	/** History group header — last active earlier */
	assistantHistoryOlder: "Older",
	/** History row — a conversation whose first message was empty after trimming */
	assistantHistoryUntitled: "Untitled conversation",
	/** History — nothing saved yet */
	assistantHistoryEmpty: "No saved conversations yet",
	/** History — where conversations are kept; the privacy promise */
	assistantHistoryNote: "Conversations are saved on this device only and removed when you sign out.",
	/** History row — button that deletes one conversation; {{title}} is its title */
	assistantHistoryDelete: "Delete “{{title}}”",
	/** Delete-conversation confirmation — title */
	assistantHistoryDeleteTitle: "Delete this conversation?",
	/** Delete-conversation confirmation — body; {{title}} is its title */
	assistantHistoryDeleteBody: "“{{title}}” is removed from this device. This can't be undone.",
	/** Delete-conversation confirmation — confirm button */
	assistantHistoryDeleteConfirm: "Delete",
	/** History — removes every saved conversation */
	assistantHistoryClear: "Clear history",
	/** Clear-history confirmation — title */
	assistantHistoryClearTitle: "Clear the conversation history?",
	/** Clear-history confirmation — body */
	assistantHistoryClearBody: "Every saved conversation, including the one open now, is removed from this device. This can't be undone.",
	/** Clear-history confirmation — confirm button */
	assistantHistoryClearConfirm: "Clear history",
	/** Toast — a saved conversation could not be read (deleted in another tab, or storage failed) */
	assistantHistoryOpenFailed: "Couldn't open this conversation",
	/** History — shown while the model can't be used yet; deleting still works */
	assistantHistoryNeedsModel: "Conversations open once the assistant is ready.",
	/** Toast — deleting or clearing saved conversations failed */
	assistantHistoryDeleteFailed: "Couldn't delete the saved conversations",

	// ── Status chip in the header ────────────────────────────────────────────
	/** Status chip — the device can't run the model */
	assistantStatusUnavailable: "Unavailable",
	/** Status chip — another Filen tab or window has the model loaded */
	assistantStatusInUseElsewhere: "In use elsewhere",
	/** Status chip — the model hasn't been downloaded yet */
	assistantStatusNotDownloaded: "Not set up",
	/** Status chip — download progress, a whole percentage */
	assistantStatusDownloading: "Downloading {{percent}}%",
	/** Status chip — the download is paused until the device is back online; it continues on its own */
	assistantStatusDownloadWaiting: "Waiting for connection",
	/** Status chip — downloaded, but not in memory; sending a message loads it */
	assistantStatusNotLoaded: "Not loaded",
	/** Status chip — the downloaded model is being loaded into memory */
	assistantStatusLoading: "Loading",
	/** Status chip — ready, and running on this device */
	assistantStatusReady: "On this device",
	/** Status chip — downloading or starting the model failed */
	assistantStatusError: "Error",

	// ── Setup (first run) ────────────────────────────────────────────────────
	/** Setup screen — accessible name of the spinner while the app checks the device and the downloaded model */
	assistantChecking: "Checking the assistant",
	/** Setup screen — title */
	assistantSetupTitle: "A private assistant on this device",
	/** Setup screen — what it is and the privacy promise: the model runs locally, nothing is sent anywhere */
	assistantSetupBody:
		"Ask it to find, open and summarize your files, notes and chats. It runs entirely on this device: your data and your questions are never sent to Filen or anyone else.",
	/** Setup screen — label of the recommended model's name */
	assistantSetupModel: "Model",
	/** Setup screen — label of the one-time download size */
	assistantSetupSize: "Download",
	/** Setup screen — the model is stored locally and survives signing out */
	assistantSetupStorageNote: "Downloaded once and kept on this device, also after you sign out.",
	/** Setup screen — starts the model download */
	assistantDownload: "Download model",
	/** Setup screen — the device check failed; the download button stays disabled below this */
	assistantUnavailableTitle: "The assistant can't run here",
	/** Unavailable reason — the browser lacks what the model needs */
	assistantUnavailableUnsupportedBrowser: "The assistant's model needs graphics features that aren't available here.",
	/** Follows assistantUnavailableUnsupportedBrowser in a browser only (the desktop app cannot switch browsers) */
	assistantUnavailableUnsupportedBrowserAdvice: "Try a recent version of Chrome, Edge or Firefox on a computer.",
	/** Unavailable reason — not enough memory */
	assistantUnavailableInsufficientMemory: "This device doesn't have enough memory to run the assistant's model.",
	/** Another Filen tab or window holds the model; it becomes available here once that one closes it — title */
	assistantInUseElsewhereTitle: "Already open elsewhere",
	/** Another Filen tab or window holds the model — explanation; no action is offered */
	assistantInUseElsewhereBody:
		"The assistant runs in one place at a time. Close it where it is open, or use it there; it becomes available here on its own.",

	// ── Download and start ───────────────────────────────────────────────────
	/** Download in progress — title */
	assistantDownloadingTitle: "Downloading the model",
	/** Download in progress — bytes received of the total, e.g. "1.2 GiB of 2.6 GiB" */
	assistantDownloadProgress: "{{received}} of {{total}}",
	/** Download in progress — offline, or retrying after the connection dropped; it continues on its own */
	assistantDownloadWaiting: "Waiting for the connection…",
	/** Download in progress — every byte has arrived, the last checks are running */
	assistantDownloadFinishing: "Finishing the download…",
	/** Download in progress — accessible name of the progress bar */
	assistantDownloadProgressLabel: "Model download",
	/** Download in progress — stops it */
	assistantCancelDownload: "Cancel download",
	/** Download in progress — it was not started by a click this time: it continues the one the user started before the page was reloaded, closed or crashed */
	assistantDownloadResumed: "Continued where your last download stopped.",
	/** Toast — an interrupted model download continues on its own after the app was reopened */
	assistantDownloadResumedToast: "Continuing the assistant's model download",
	/** Toast — how much was already on this device, e.g. "1.2 GiB of 2.6 GiB" */
	assistantDownloadResumedToastBody: "{{received}} of {{total}} is already on this device.",
	/** Assistant button in the icon rail — accessible name while the model downloads; stays the same throughout, the percentage is in the tooltip */
	assistantToggleDownloading: "Assistant, downloading the model",
	/** Assistant button in the icon rail — accessible name while the panel is hidden and the assistant works on a request */
	assistantToggleWorking: "Assistant, working",
	/** Assistant button in the icon rail — accessible name while the panel is hidden and an action waits for the user to confirm or decline it */
	assistantToggleWaiting: "Assistant, waiting for your confirmation",
	/** Assistant button in the icon rail — accessible name after the assistant finished a request while the panel was hidden */
	assistantToggleFinished: "Assistant, new reply",
	/** Assistant button's tooltip in the icon rail — after its name, while the assistant works on a request */
	assistantRailWorking: "Working…",
	/** Assistant button's tooltip in the icon rail — after its name, while an action waits for the user */
	assistantRailWaiting: "Waiting for your confirmation",
	/** Assistant button's tooltip in the icon rail — after its name, once a request finished while the panel was hidden */
	assistantRailFinished: "New reply",
	/** Toast — the assistant proposed an action (e.g. a chat draft) while its panel was hidden; it does nothing until the user confirms it there */
	assistantConfirmationToast: "The assistant is waiting for your confirmation",
	/** Toast action — shows the assistant panel */
	assistantConfirmationToastShow: "Show",
	/** The downloaded model is being loaded into memory */
	assistantLoadingTitle: "Loading model…",
	/** Before starting, the downloaded model's files are checked because a record of them was lost or the last start failed */
	assistantVerifyingTitle: "Checking the downloaded model…",
	/** Download or start failed — title above the reason */
	assistantErrorTitle: "The assistant couldn't start",
	/** Failure reason — the download broke off */
	assistantErrorDownloadFailed: "The download failed. Check your connection and try again.",
	/** Failure reason — the model couldn't be loaded */
	assistantErrorLoadFailed: "The model couldn't be started.",
	/** Failure reason — out of memory while loading */
	assistantErrorOutOfMemory: "This device ran out of memory while starting the model. Close other apps and try again.",
	/** Failure reason — storage filled up during the download */
	assistantErrorStorageFull: "This device ran out of storage while downloading the model.",
	/** Failure — retries the download or start */
	assistantRetry: "Try again",
	/** Above the composer — the downloaded model isn't in memory yet; nothing is wrong */
	assistantModelNotLoaded: "The model loads when you send a message.",
	/** Above the composer — the model was unloaded after a while without use to free memory; nothing is wrong */
	assistantModelIdleUnloaded: "Unloaded while unused to free memory. It loads again when you send a message.",
	/** Above the composer — loads the downloaded model now, ahead of the first message */
	assistantLoadModel: "Load model",

	// ── Conversation ─────────────────────────────────────────────────────────
	/** Empty conversation — title */
	assistantEmptyTitle: "Ask about your files, notes and chats",
	/** Empty conversation — subtitle */
	assistantEmptyBody: "Everything stays on this device. Try one of these:",
	/** Empty conversation — accessible name of the example prompt group */
	assistantExamplesLabel: "Example questions",
	/** Example prompt — sent as typed when clicked */
	assistantExampleFind: "Find my tax documents",
	/** Example prompt — sent as typed when clicked */
	assistantExampleSummarize: "Summarize the note I have open",
	/** Example prompt — sent as typed when clicked */
	assistantExampleOpen: "What's in my Documents directory?",
	/** Example prompt — sent as typed when clicked */
	assistantExampleNavigate: "Take me to my favorites",
	/** Conversation scroller — accessible name */
	assistantConversationLabel: "Conversation",
	/** Screen-reader prefix on the user's own messages, read right before the message text */
	assistantYouSaid: "You: ",
	/** Accessible name of one assistant reply */
	assistantReplyLabel: "Assistant reply",
	/** Announced while the assistant works without a step to name, e.g. between steps */
	assistantResponding: "Assistant is responding…",
	/** Turn ended — the user pressed Stop */
	assistantTurnCancelled: "Stopped",
	/** Turn failed — the model isn't loaded */
	assistantTurnErrorModelUnavailable: "The model isn't ready.",
	/** Turn failed — the conversation outgrew the model's context */
	assistantTurnErrorContextFull: "This conversation is too long. Start a new one to continue.",
	/** Turn failed — the user's message alone is too long for the model */
	assistantTurnErrorMessageTooLong: "This message is too long for the assistant. Try a shorter one.",
	/** Turn ended without any reply text to show */
	assistantTurnErrorNoReply: "The assistant didn't come up with a reply. Try rephrasing your request.",
	/** Turn end — a confirmation card was left unanswered for a while, so the assistant stopped waiting for it */
	assistantTurnErrorExpired: "The confirmation timed out.",
	/** Shown in place of a reply that was hidden because it repeated the assistant's internal instructions */
	assistantReplyWithheld: "This reply was hidden because it repeated the assistant's internal instructions.",
	/** Turn failed — anything else */
	assistantTurnErrorFailed: "Something went wrong while answering.",

	// ── Progress steps (a turn's list above its reply: live while it runs, then one summary line) ─
	/** Step — the downloaded model is being loaded into memory before the reply */
	assistantStepLoading: "Loading the model",
	/** Step — the model finished loading */
	assistantStepLoaded: "Loaded the model",
	/** Step — the model couldn't be loaded */
	assistantStepLoadFailed: "Couldn't load the model",
	/** Step — the model reads the message to decide what kind of request it is */
	assistantStepRouting: "Reading your request",
	/** Step — the request was understood as being about files and directories */
	assistantStepRoutedFiles: "Working with your files",
	/** Step — the request was understood as asking about recent files, file sizes or storage space */
	assistantStepRoutedInsights: "Looking into your drive",
	/** Step — the request was understood as asking about favorites, shared items or public links */
	assistantStepRoutedShared: "Checking favorites and shares",
	/** Step — the request was understood as creating, renaming, moving or copying files */
	assistantStepRoutedOrganize: "Organizing your files",
	/** Step — the request was understood as renaming or sorting many files at once by a pattern or date */
	assistantStepRoutedBatch: "Working with many files at once",
	/** Step — the request was understood as being about the trash */
	assistantStepRoutedTrash: "Working with the trash",
	/** Step — the request was understood as restoring items from the trash */
	assistantStepRoutedRestore: "Restoring from the trash",
	/** Step — the request was understood as being about notes */
	assistantStepRoutedNotes: "Working with your notes",
	/** Step — the request was understood as being about chats */
	assistantStepRoutedChats: "Working with your chats",
	/** Step — the request was understood as being about music playback */
	assistantStepRoutedAudio: "Working with your music",
	/** Step — the request was understood as opening a part of the app */
	assistantStepRoutedNavigation: "Working with the app",
	/** Step — the request was understood as asking how the app works, or about desktop sync and mount status */
	assistantStepRoutedHelp: "Looking up app help and status",
	/** Step — the request needs no tools; the assistant answers from the conversation */
	assistantStepRoutedAnswer: "Answering directly",
	/** Step — the model decides what to do next */
	assistantStepThinking: "Thinking",
	/** Step — the model reads everything gathered and starts the reply */
	assistantStepReplying: "Writing the reply",
	/** Step — search_items; subject is the search text */
	assistantStepSearchItems: 'Searching for "{{subject}}"',
	/** Step — list_directory; subject is the directory's name or path */
	assistantStepListDirectory: 'Listing "{{subject}}"',
	/** Step — get_item_info; subject is the item's name */
	assistantStepGetItemInfo: 'Checking "{{subject}}"',
	/** Step — get_sharing; subject is the item's name */
	assistantStepGetSharing: 'Checking how "{{subject}}" is shared',
	/** Step — read_text_file; subject is the file's name */
	assistantStepReadTextFile: 'Reading "{{subject}}"',
	/** Step — read_document; subject is the document's name */
	assistantStepReadDocument: 'Reading "{{subject}}"',
	/** Step — reveal_item; subject is the item's name */
	assistantStepRevealItem: 'Showing "{{subject}}" in your drive',
	/** Step — set_favorite; subject is the item's name */
	assistantStepSetFavorite: 'Updating favorites for "{{subject}}"',
	/** Step — create_directory; subject is the new directory's name */
	assistantStepCreateDirectory: 'Creating the directory "{{subject}}"',
	/** Step — rename_item; subject is the item's current name */
	assistantStepRenameItem: 'Renaming "{{subject}}"',
	/** Step — move_items; subject is the item's name */
	assistantStepMoveItems: 'Moving "{{subject}}"',
	/** Step — copy_items; subject is the item's name */
	assistantStepCopyItems: 'Copying "{{subject}}"',
	/** Step — rename_by_pattern; subject is the directory's name, the one file's name or the text added */
	assistantStepRenameByPattern: 'Renaming files by a pattern ("{{subject}}")',
	/** Step — organize_by_date; subject is the directory's name */
	assistantStepOrganizeByDate: 'Sorting "{{subject}}" into subdirectories by date',
	/** Step — trash_items; subject is the item's name */
	assistantStepTrashItems: 'Moving "{{subject}}" to the trash',
	/** Step — restore_items; subject is the item's name */
	assistantStepRestoreItems: 'Restoring "{{subject}}" from the trash',
	/** Step — list_notes; subject is the search text */
	assistantStepListNotes: 'Searching notes for "{{subject}}"',
	/** Step — read_note; subject is the note's title */
	assistantStepReadNote: 'Reading the note "{{subject}}"',
	/** Step — search_note_text; subject is the search text */
	assistantStepSearchNoteText: 'Searching the text of your notes for "{{subject}}"',
	/** Step — open_note; subject is the note's title */
	assistantStepOpenNote: 'Opening the note "{{subject}}"',
	/** Step — create_note; subject is the new note's title */
	assistantStepCreateNote: 'Creating the note "{{subject}}"',
	/** Step — set_note_flags; subject is the note's title */
	assistantStepSetNoteFlags: 'Updating the note "{{subject}}"',
	/** Step — list_chats; subject is the search text */
	assistantStepListChats: 'Searching chats for "{{subject}}"',
	/** Step — read_chat; subject is the chat's name */
	assistantStepReadChat: 'Reading the chat "{{subject}}"',
	/** Step — open_chat; subject is the chat's name */
	assistantStepOpenChat: 'Opening the chat "{{subject}}"',
	/** Step — draft_chat_message; subject is the chat's name */
	assistantStepDraftChatMessage: 'Drafting a message to "{{subject}}"',
	/** Step — find_contacts; subject is the name or address searched for */
	assistantStepFindContacts: 'Looking up the contact "{{subject}}"',
	/** Step — open_playlist; subject is the playlist's name */
	assistantStepOpenPlaylist: 'Opening the playlist "{{subject}}"',
	/** Step — play; subject is the track's or playlist's name */
	assistantStepPlay: 'Playing "{{subject}}"',
	/** Step — add_tracks_to_playlist; subject is the playlist's name */
	assistantStepAddTracksToPlaylist: 'Adding tracks to "{{subject}}"',
	/** Step result — how many files and directories a listing or search returned */
	assistantStepCountItems_one: "{{count}} item",
	/** Step result — how many files and directories a listing or search returned */
	assistantStepCountItems_other: "{{count}} items",
	/** Step result — an incomplete search (index still building, too many names, failed) found none */
	assistantStepCountItemsMore_zero: "None found, search incomplete",
	/** Step result — an incomplete search returned this many; whether more exist is unknown */
	assistantStepCountItemsMore_one: "{{count}} item, search incomplete",
	/** Step result — an incomplete search returned this many; whether more exist is unknown */
	assistantStepCountItemsMore_other: "{{count}} items, search incomplete",
	/** Step result — how many notes a listing returned */
	assistantStepCountNotes_one: "{{count}} note",
	/** Step result — how many notes a listing returned */
	assistantStepCountNotes_other: "{{count}} notes",
	/** Step result — how many chats a listing returned */
	assistantStepCountChats_one: "{{count}} chat",
	/** Step result — how many chats a listing returned */
	assistantStepCountChats_other: "{{count}} chats",
	/** Step result — how many playlists a listing returned */
	assistantStepCountPlaylists_one: "{{count}} playlist",
	/** Step result — how many playlists a listing returned */
	assistantStepCountPlaylists_other: "{{count}} playlists",
	/** Step progress — a drive search still running; how many names it is still checking against the query, {{figure}} is the formatted count */
	assistantStepCandidates_one: "{{figure}} candidate",
	/** Step progress — a drive search still running; how many names it is still checking against the query, {{figure}} is the formatted count */
	assistantStepCandidates_other: "{{figure}} candidates",
	/** Step state — the action waits for the user's confirmation on the card below */
	assistantStepWaiting: "Waiting for your confirmation",
	/** Step state — the action is ready and runs once the one before it finished */
	assistantStepQueued: "Up next",
	/** Step result — the model asked for something malformed; it may try again */
	assistantStepFailedInvalid: "Not understood",
	/** Step result — the action failed */
	assistantStepFailedError: "Failed",
	/** Step result — the assistant isn't allowed to do this for this request */
	assistantStepFailedBlocked: "Not allowed",
	/** Step result — the user declined the action */
	assistantStepFailedDeclined: "Declined",
	/** Step result — the model asked for the same thing again; the earlier result is used instead */
	assistantStepFailedRepeated: "Already done",
	/** Step result — the user stopped the reply while this step ran */
	assistantStepStopped: "Stopped",
	/** Collapsed steps — how many actions the assistant took and how long the whole reply took */
	assistantStepsSummaryTools_one: "Used {{count}} tool · {{duration}}",
	/** Collapsed steps — how many actions the assistant took and how long the whole reply took */
	assistantStepsSummaryTools_other: "Used {{count}} tools · {{duration}}",
	/** Collapsed steps — a reply that needed no actions; how long it took */
	assistantStepsSummary: "Worked for {{duration}}",
	/** Collapsed steps — screen-reader text on the warning sign shown when a step failed */
	assistantStepsSummaryFailed: "A step failed",
	/** Accessible name of a turn's step list */
	assistantStepsLabel: "Steps",
	/** A duration in seconds, e.g. "4.2 s" */
	assistantDurationSeconds: "{{seconds}} s",

	// ── Tool activity (a step's line when it names no single item) ─────────
	/** Activity — get_context */
	assistantToolGetContext: "Looking at your screen",
	/** Activity — search_items */
	assistantToolSearchItems: "Searching your drive",
	/** Activity — list_directory */
	assistantToolListDirectory: "Listing a directory",
	/** Activity — get_item_info */
	assistantToolGetItemInfo: "Checking item details",
	/** Activity — recent_items */
	assistantToolRecentItems: "Checking your recent files",
	/** Activity — list_photos */
	assistantToolListPhotos: "Looking through your photos",
	/** Activity — get_storage */
	assistantToolGetStorage: "Checking your storage space",
	/** Activity — list_section: the favorites, the trash, shared items or public links */
	assistantToolListSection: "Checking a list in your drive",
	/** Activity — get_sharing */
	assistantToolGetSharing: "Checking links and shares",
	/** Activity — read_text_file */
	assistantToolReadTextFile: "Reading a file",
	/** Activity — read_document */
	assistantToolReadDocument: "Reading a document",
	/** Activity — reveal_item */
	assistantToolRevealItem: "Showing an item in your drive",
	/** Activity — set_favorite */
	assistantToolSetFavorite: "Updating favorites",
	/** Activity — create_directory */
	assistantToolCreateDirectory: "Creating a directory",
	/** Activity — rename_item */
	assistantToolRenameItem: "Renaming an item",
	/** Activity — move_items */
	assistantToolMoveItems: "Moving items",
	/** Activity — copy_items */
	assistantToolCopyItems: "Copying items",
	/** Activity — rename_by_pattern */
	assistantToolRenameByPattern: "Renaming files",
	/** Activity — organize_by_date */
	assistantToolOrganizeByDate: "Sorting files into subdirectories by date",
	/** Activity — trash_items */
	assistantToolTrashItems: "Moving items to the trash",
	/** Activity — restore_items */
	assistantToolRestoreItems: "Restoring items from the trash",
	/** Activity — list_notes */
	assistantToolListNotes: "Listing your notes",
	/** Activity — read_note */
	assistantToolReadNote: "Reading a note",
	/** Activity — search_note_text */
	assistantToolSearchNoteText: "Searching the text of your notes",
	/** Activity — open_note */
	assistantToolOpenNote: "Opening a note",
	/** Activity — create_note */
	assistantToolCreateNote: "Creating a note",
	/** Activity — set_note_flags */
	assistantToolSetNoteFlags: "Updating a note",
	/** Activity — list_chats */
	assistantToolListChats: "Listing your chats",
	/** Activity — read_chat */
	assistantToolReadChat: "Reading a chat",
	/** Activity — open_chat */
	assistantToolOpenChat: "Opening a chat",
	/** Activity — draft_chat_message */
	assistantToolDraftChatMessage: "Drafting a message",
	/** Activity — find_contacts */
	assistantToolFindContacts: "Looking up a contact",
	/** Activity — list_playlists */
	assistantToolListPlaylists: "Listing your playlists",
	/** Activity — open_playlist */
	assistantToolOpenPlaylist: "Opening a playlist",
	/** Activity — play */
	assistantToolPlay: "Starting playback",
	/** Activity — audio_control */
	assistantToolAudioControl: "Controlling playback",
	/** Activity — add_tracks_to_playlist */
	assistantToolAddTracksToPlaylist: "Adding tracks to a playlist",
	/** Activity — get_transfers */
	assistantToolGetTransfers: "Checking your transfers",
	/** Activity — app_help */
	assistantToolAppHelp: "Looking up help",
	/** Activity — get_desktop_status */
	assistantToolGetDesktopStatus: "Checking sync and mounts",
	/** Activity — open_route */
	assistantToolOpenRoute: "Opening a screen",
	/** Activity — a tool this version has no wording for */
	assistantToolGeneric: "Working",

	// ── Confirmation cards ───────────────────────────────────────────────────
	/** Card title — a drafted chat message, before it goes into the chat's input field */
	assistantProposalDraftMessage: "Put this draft into {{chat}}?",
	/** Draft card — the user still sends the message; nothing is sent automatically */
	assistantProposalDraftNote: "You still send it yourself.",
	/** Draft card — accessible name of the drafted message text */
	assistantProposalDraftText: "Draft",
	/** Draft card — the email addresses of the people the drafted message would reach */
	assistantProposalDraftTo: "To: {{recipients}}",
	/** Draft card — the first email addresses of a group chat's members, and how many more there are */
	assistantProposalDraftToMore: "To: {{recipients}} and {{count}} more",
	/** Draft card — confirm button */
	assistantConfirmDraft: "Add draft",
	/** Card title — move */
	assistantProposalMove_one: "Move {{count}} item",
	/** Card title — move */
	assistantProposalMove_other: "Move {{count}} items",
	/** Card title — copy */
	assistantProposalCopy_one: "Copy {{count}} item",
	/** Card title — copy */
	assistantProposalCopy_other: "Copy {{count}} items",
	/** Card title — trash */
	assistantProposalTrash_one: "Move {{count}} item to the trash",
	/** Card title — trash */
	assistantProposalTrash_other: "Move {{count}} items to the trash",
	/** Card title — restore from the trash */
	assistantProposalRestore_one: "Restore {{count}} item from the trash",
	/** Card title — restore from the trash */
	assistantProposalRestore_other: "Restore {{count}} items from the trash",
	/** Card title — rename many files by a pattern or their dates */
	assistantProposalBatchRename_one: "Rename {{count}} file",
	/** Card title — rename many files by a pattern or their dates */
	assistantProposalBatchRename_other: "Rename {{count}} files",
	/** Card title — sort a directory's files into subdirectories by year, month or day */
	assistantProposalOrganizeByDate_one: "Sort {{count}} file into subdirectories by date",
	/** Card title — sort a directory's files into subdirectories by year, month or day */
	assistantProposalOrganizeByDate_other: "Sort {{count}} files into subdirectories by date",
	/** Card title — rename */
	assistantProposalRename_one: "Rename {{count}} item",
	/** Card title — rename */
	assistantProposalRename_other: "Rename {{count}} items",
	/** Card title — add to favorites */
	assistantProposalFavorite_one: "Add {{count}} item to favorites",
	/** Card title — add to favorites */
	assistantProposalFavorite_other: "Add {{count}} items to favorites",
	/** Card title — remove from favorites */
	assistantProposalUnfavorite_one: "Remove {{count}} item from favorites",
	/** Card title — remove from favorites */
	assistantProposalUnfavorite_other: "Remove {{count}} items from favorites",
	/** Card title — create a directory */
	assistantProposalCreateDirectory: "Create a directory",
	/** Card title — create a note */
	assistantProposalCreateNote: "Create a note",
	/** Card title — pin, favorite or archive a note, or undo that */
	assistantProposalNoteFlags: "Change a note",
	/** Card title — add tracks to a playlist */
	assistantProposalAddTracks_one: "Add {{count}} track to a playlist",
	/** Card title — add tracks to a playlist */
	assistantProposalAddTracks_other: "Add {{count}} tracks to a playlist",
	/** Card field — the playlist tracks are added to */
	assistantProposalPlaylist: "Playlist",
	/** Card — accessible name of the list of changes to a note */
	assistantProposalChanges: "Changes",
	/** Note card change — the note gets pinned */
	assistantProposalPin: "Pin",
	/** Note card change — the note gets unpinned */
	assistantProposalUnpin: "Unpin",
	/** Note card change — the note is added to favorites */
	assistantProposalNoteFavorite: "Add to favorites",
	/** Note card change — the note is removed from favorites */
	assistantProposalNoteUnfavorite: "Remove from favorites",
	/** Note card change — the note moves to the archive */
	assistantProposalArchive: "Move to the archive",
	/** Note card change — the note leaves the archive */
	assistantProposalUnarchive: "Take out of the archive",
	/** Card field — the target directory of a move, copy or create */
	assistantProposalDestination: "In",
	/** Card field — the new name of a rename or create */
	assistantProposalName: "Name",
	/** Card field — the new name a rename gives an item */
	assistantProposalNewName: "New name",
	/** Card field — the title of a note the assistant creates */
	assistantProposalNoteTitle: "Title",
	/** Card field — the type of a note the assistant creates (text, markdown, checklist, ...) */
	assistantProposalNoteType: "Type",
	/** Card field — any other free-text argument */
	assistantProposalText: "Text",
	/** Card — accessible name of the affected-items list */
	assistantProposalItems: "Items",
	/** Card field — the text a batch rename replaces in each name */
	assistantProposalFind: "Replace",
	/** Batch card summary — the rule: today's date goes before each name ({{date}} is which date, e.g. "date taken") */
	assistantBatchRuleDatePrefix: "Date before the name ({{date}})",
	/** Batch card summary — the rule: each file is named by its date ({{date}} is which date) */
	assistantBatchRuleDateName: "Date as the name ({{date}})",
	/** Batch card summary — the rule: the files are numbered */
	assistantBatchRuleNumber: "Numbered",
	/** Batch card summary — the rule: text is added before each name */
	assistantBatchRuleAddPrefix: "Text added before the name",
	/** Batch card summary — the rule: text is added after each name, before the extension */
	assistantBatchRuleAddSuffix: "Text added after the name",
	/** Batch card summary — the rule: text in each name is replaced */
	assistantBatchRuleReplaceText: "Text replaced",
	/** Batch card summary — the rule: names become lowercase */
	assistantBatchRuleLowercase: "Lowercase",
	/** Sort card summary — files go into a subdirectory per year ({{date}} is which date) */
	assistantBatchRuleByYear: "By year ({{date}})",
	/** Sort card summary — files go into a subdirectory per month ({{date}} is which date) */
	assistantBatchRuleByMonth: "By month ({{date}})",
	/** Sort card summary — files go into a subdirectory per day ({{date}} is which date) */
	assistantBatchRuleByDay: "By day ({{date}})",
	/** Batch card summary — which date: when the photo or video was taken, else the file's own date */
	assistantBatchDateTaken: "date taken",
	/** Batch card summary — which date: the file's creation date */
	assistantBatchDateCreated: "date created",
	/** Batch card summary — which date: the file's last modification */
	assistantBatchDateModified: "date modified",
	/** Batch card summary — which date: when the file was uploaded */
	assistantBatchDateUploaded: "date uploaded",
	/** Batch card summary — how many files stay as they are */
	assistantBatchSkipped_one: "{{count}} skipped",
	/** Batch card summary — how many files stay as they are */
	assistantBatchSkipped_other: "{{count}} skipped",
	/** Batch card summary — how many files got " (2)" etc. because their new name was taken */
	assistantBatchSuffixed_one: "{{count}} numbered to avoid a clash",
	/** Batch card summary — how many files got " (2)" etc. because their new name was taken */
	assistantBatchSuffixed_other: "{{count}} numbered to avoid a clash",
	/** Batch card row tag — this file's new name got " (2)" etc. because the name was taken */
	assistantBatchSuffixedTag: "numbered",
	/** Batch card row — a file left as it is, because its new name would not be a valid one */
	assistantBatchSkipInvalidName: "skipped: not a valid name",
	/** Sort card row — a file left where it is, because a file already has its subdirectory's name */
	assistantBatchSkipDestinationIsFile: "skipped: a file has the subdirectory's name",
	/** Sort card group — the subdirectory will be created */
	assistantBatchGroupNew: "new",
	/** Sort card group — the subdirectory exists already */
	assistantBatchGroupExists: "exists",
	/** Sort card group — how many files go into this subdirectory */
	assistantBatchGroupCount_one: "{{count}} file",
	/** Sort card group — how many files go into this subdirectory */
	assistantBatchGroupCount_other: "{{count}} files",
	/** Sort card note — files whose name the subdirectory already holds move under a numbered name */
	assistantBatchRenamedOnMove_one: "{{count}} file moves under a numbered name, as its name is taken there",
	/** Sort card note — files whose name the subdirectory already holds move under a numbered name */
	assistantBatchRenamedOnMove_other: "{{count}} files move under a numbered name, as their names are taken there",
	/** Batch card — runs the renames */
	assistantConfirmBatchRename_one: "Rename {{count}}",
	/** Batch card — runs the renames */
	assistantConfirmBatchRename_other: "Rename {{count}}",
	/** Sort card — runs the moves */
	assistantConfirmOrganize_one: "Move {{count}}",
	/** Sort card — runs the moves */
	assistantConfirmOrganize_other: "Move {{count}}",
	/** Restore card — where a restored note returns: the notes list */
	assistantProposalRestoreToNotes: "to Notes",
	/** Restore card — where a restored file or directory returns; {{path}} is that directory's path, e.g. /Documents/Work */
	assistantProposalRestoreToPath: "to {{path}}",
	/** Restore card — where a restored file or directory returns when its directory's path is not known */
	assistantProposalRestoreToOriginal: "to its original directory",
	/** Restore card — runs the restore */
	assistantConfirmRestore_one: "Restore {{count}}",
	/** Restore card — runs the restore */
	assistantConfirmRestore_other: "Restore {{count}}",
	/** Card — runs the action */
	assistantConfirm: "Confirm",
	/** Card — runs a trash action */
	assistantConfirmTrash: "Move to trash",
	/** Card — declines the action */
	assistantDecline: "Cancel",
	/** Card status — confirmed, in progress */
	assistantProposalRunning: "Working…",
	/** Card status — finished */
	assistantProposalDone: "Done",
	/** Card status — failed */
	assistantProposalFailed: "Couldn't finish this",
	/** Card status — declined */
	assistantProposalCancelled: "Cancelled",
	/** Card status — a newer message was sent before it was answered */
	assistantProposalExpired: "Expired. Ask again to do this.",
	/** Card status — a saved card that was still running when its conversation was left */
	assistantProposalInterrupted: "This may have finished after you left. Check before asking again.",
	/** Announced when a card appears and waits for the user */
	assistantProposalAnnouncement: "Confirmation needed: {{title}}",
	/** Announced for a step — what it does, then what came of it (e.g. "Searching for “tax”, 4 items") */
	assistantStepAnnouncement: "{{label}}, {{detail}}",

	// ── Composer ─────────────────────────────────────────────────────────────
	/** Composer — placeholder and accessible name */
	assistantComposerPlaceholder: "Ask the assistant",
	/** Composer — send button */
	assistantSend: "Send",
	/** Composer — stops the reply being generated */
	assistantStop: "Stop",
	/** Under the composer, always shown: a reminder that the assistant's answers and changes can be wrong */
	assistantComposerDisclaimer: "The assistant can make mistakes. Check its answers and changes.",

	// ── Conversation history: retention ──────────────────────────────────────
	/** History footer — how long saved conversations are kept (Settings > Assistant > Keep conversations): never removed by age */
	assistantHistoryKeptForever: "Kept forever",
	/** History footer — saved conversations are removed 30 days after their last message */
	assistantHistoryKept30Days: "Kept for 30 days",
	/** History footer — saved conversations are removed 7 days after their last message */
	assistantHistoryKept7Days: "Kept for 7 days",
	/** History footer — saved conversations are removed 1 day after their last message */
	assistantHistoryKept1Day: "Kept for 1 day",
	/** History footer — saving conversations is turned off */
	assistantHistoryNotSaved: "Not saved",
	/** History footer — link to the setting that decides how long conversations are kept; follows the retention text */
	assistantHistoryRetentionChange: "Change",
	/** History footer — accessible name of the Change link */
	assistantHistoryRetentionChangeLabel: "Change how long conversations are kept",
	/** History — shown in place of the list while saving is off */
	assistantHistoryOffNote: "Saving is off. A conversation lasts until you start a new one or close the page.",

	// ── Selection transform (notes, Word documents, the chat composer) ──────
	/** Button beside a text selection and the context menu's submenu — opens the rewrite menu */
	assistantTransformOpen: "Rewrite with assistant",
	/** Rewrite menu — rewrites the selection more clearly; also the result's heading */
	assistantTransformRewrite: "Rewrite",
	/** Rewrite menu — makes the selection shorter; also the result's heading */
	assistantTransformShorten: "Shorten",
	/** Rewrite menu — corrects spelling, grammar and punctuation only; also the result's heading */
	assistantTransformFixGrammar: "Fix grammar",
	/** Rewrite menu — submenu of target languages */
	assistantTransformTranslate: "Translate",
	/** Translate submenu — the full list of languages, after the recently used ones */
	assistantTransformAllLanguages: "All languages…",
	/** Result heading for a translation, e.g. "Translate to German" */
	assistantTransformTranslateTo: "Translate to {{language}}",
	/** Result — accessible name of the result popover */
	assistantTransformResultLabel: "Assistant result",
	/** Result — replaces the selection with the result */
	assistantTransformAccept: "Accept",
	/** Result — runs the same request again */
	assistantTransformTryAgain: "Try again",
	/** Result — closes it and leaves the text as it was; also stops one still being written */
	assistantTransformDiscard: "Discard",
	/** Result — toggle between the result and its changes against the selection */
	assistantTransformChanges: "Changes",
	/** Result — the model is being loaded into memory first */
	assistantTransformLoading: "Loading the model…",
	/** Result — the model is reading the selection, before the first word */
	assistantTransformReading: "Reading the text…",
	/** Result — the result is being written (screen readers) */
	assistantTransformWriting: "Writing…",
	/** Result — the text was edited while the result was written; Accept is off */
	assistantTransformSelectionChanged: "The text changed since you asked. Select it again for a new result.",
	/** Result — the result holds links or addresses the selection did not; Accept is off. `links` lists them */
	assistantTransformForeignLinks: "This adds links or addresses your text didn't have: {{links}}. It can't be applied.",
	/** Result — the result stopped at its length limit; Accept is off */
	assistantTransformTruncated: "The result was cut off, so it can't be applied. Select less text.",
	/** Result — the model wrote nothing */
	assistantTransformEmpty: "The assistant returned nothing. Try again.",
	/** Result — the selection is longer than one request takes */
	assistantTransformTooLong: "This is too long to do in one go. Select a shorter passage.",
	/** Result — the selection holds a table, field, picture or tracked change, which a plain-text result would lose */
	assistantTransformUnsupported:
		"This selection holds more than plain text (a table, field, picture or tracked change), so it can't be rewritten.",
	/** Result — the generation failed */
	assistantTransformFailed: "Couldn't do this. Try again.",
	/** Result — the editor refused the replacement (a protected part, a read-only document) */
	assistantTransformRefused: "The document didn't accept this change.",
	/** Result — the model is not on this device yet; the Download button follows */
	assistantTransformNotDownloaded: "Rewriting runs on this device with the assistant's model, which isn't downloaded yet.",
	/** Result — downloads the model; `size` is its download size, e.g. "2.4 GiB" */
	assistantTransformDownload: "Download ({{size}})",
	/** Result — another tab or window holds the model */
	assistantTransformInUseElsewhere: "The assistant is in use in another tab or window. It becomes available here once it's closed there.",
	/** Result — the device or browser cannot run the model */
	assistantTransformUnavailable: "The assistant can't run on this device.",
	/** Result — the model failed to download or load; the Try again button follows */
	assistantTransformModelFailed: "The assistant's model couldn't be loaded.",
	/** Toast — the result replaced the selection where the editor keeps no undo of it; its Undo button puts the text back */
	assistantTransformApplied: "Text replaced",
	/** Toast button — puts the text back as it was before the result replaced it */
	assistantTransformUndo: "Undo",

	// ── Open document chip ───────────────────────────────────────────────────
	/** Chip above the composer — screen-reader prefix before the open document's name */
	assistantDocumentChipLabel: "Asking about",
	/** Chip — where the user is in a PDF or Word document */
	assistantDocumentChipPage: "p. {{page}}",
	/** Chip — where the user is in a presentation */
	assistantDocumentChipSlide: "slide {{slide}}",
	/** Chip button — leaves the open document out of the next question; `name` is the document's name */
	assistantDocumentChipRemove: "Don't ask about {{name}} in the next question",

	// ── Reading a long document in parts ────────────────────────────────────
	/** Step — reading one page of a long document; `chunk` of `chunks` parts read one after the other */
	assistantStepReadingPage: "Reading page {{from}} ({{chunk}} of {{chunks}})",
	/** Step — reading pages `from` to `to` of a long document */
	assistantStepReadingPages: "Reading pages {{from}}–{{to}} ({{chunk}} of {{chunks}})",
	/** Step — reading one slide of a long presentation */
	assistantStepReadingSlide: "Reading slide {{from}} ({{chunk}} of {{chunks}})",
	/** Step — reading slides `from` to `to` of a long presentation */
	assistantStepReadingSlides: "Reading slides {{from}}–{{to}} ({{chunk}} of {{chunks}})",
	/** Step — reading one sheet of a large spreadsheet */
	assistantStepReadingSheet: "Reading sheet {{from}} ({{chunk}} of {{chunks}})",
	/** Step — reading sheets `from` to `to` of a large spreadsheet */
	assistantStepReadingSheets: "Reading sheets {{from}}–{{to}} ({{chunk}} of {{chunks}})",
	/** Step — reading a long text in parts */
	assistantStepReadingPart: "Reading part {{chunk}} of {{chunks}}",
	/** Note under a reply — the answer is based on pages `from` to `to` of a document of `units` pages */
	assistantCoveredPages: "Covered pages {{from}}–{{to}} of {{units}}.",
	/** Note under a reply — the answer is based on part of one page */
	assistantCoveredPartOfPage: "Covered part of page {{from}} of {{units}}.",
	/** Note under a reply — slides covered */
	assistantCoveredSlides: "Covered slides {{from}}–{{to}} of {{units}}.",
	/** Note under a reply — part of one slide covered */
	assistantCoveredPartOfSlide: "Covered part of slide {{from}} of {{units}}.",
	/** Note under a reply — sheets covered */
	assistantCoveredSheets: "Covered sheets {{from}}–{{to}} of {{units}}.",
	/** Note under a reply — part of one sheet covered */
	assistantCoveredPartOfSheet: "Covered part of sheet {{from}} of {{units}}.",
	/** Button after the note — asks the assistant to read the pages it did not cover */
	assistantReadRest: "Read the rest",
	/** The message Read the rest sends; `name` is the document's name */
	assistantReadRestPages: "Read {{name}} from page {{from}} to {{to}}",
	/** The message Read the rest sends for a presentation */
	assistantReadRestSlides: "Read {{name}} from slide {{from}} to {{to}}",
	/** The message Read the rest sends for a spreadsheet */
	assistantReadRestSheets: "Read {{name}} from sheet {{from}} to {{to}}",

	// ── Acting on what was read ──────────────────────────────────────────────
	/** Accessible name of the buttons under a reply written from a file, note or chat */
	assistantReplyActions: "Use this reply",
	/** Button under a reply — copies the reply as shown */
	assistantReplyCopy: "Copy",
	/** Toast — the reply was copied */
	assistantReplyCopied: "Copied",
	/** Toast — copying failed (no clipboard access) */
	assistantReplyCopyFailed: "Couldn't copy the reply",
	/** Button under a reply — saves it as a new note, after a confirmation card */
	assistantReplySaveNote: "Save as note",
	/** Button under a reply written from a chat — drafts a reply in that chat; `chat` is its name */
	assistantReplyDraft: 'Draft reply in "{{chat}}"',
	/** Button under a reply written from a chat whose name is unknown */
	assistantReplyDraftUnnamed: "Draft reply",
	/** The saved note's title; `name` is the file, note or chat the reply was written from */
	assistantSavedNoteTitle: "{{name}} – summary",
	/** The saved note's title when the source has no name */
	assistantSavedNoteTitleFallback: "Assistant summary",
	/** How a Save as note click reads in the conversation */
	assistantActSaveNote: "[Save as note]",
	/** How a Draft reply click reads in the conversation */
	assistantActDraftReply: "[Draft reply]",

	// ── Spreadsheet formula helper ───────────────────────────────────────────
	/** Spreadsheet formula bar button — opens the field to ask the assistant for a formula */
	assistantFormulaOpen: "Write a formula with the assistant",
	/** Formula helper — accessible name of its popover */
	assistantFormulaLabel: "Formula from the assistant",
	/** Formula helper — label of the field describing the formula wanted */
	assistantFormulaAskLabel: "Describe the formula",
	/** Formula helper — placeholder of the field describing the formula wanted */
	assistantFormulaAskPlaceholder: "e.g. total of Amount where Region is North",
	/** Formula helper button — asks the assistant for the formula described */
	assistantFormulaWrite: "Write",
	/** Formula helper — while the formula is being written and checked */
	assistantFormulaWriting: "Writing the formula…",
	/** Formula helper — what the spreadsheet calculated for the formula; `cell` is where it goes ("E2"), `value` the result */
	assistantFormulaResult: "Result for {{cell}}: {{value}}",
	/** Formula helper — a result of several cells; `value` is its first one, `rows` × `cols` its size */
	assistantFormulaSpills: "{{value}} (spills over {{rows}} × {{cols}} cells)",
	/** Formula helper — the formula's result is an empty cell */
	assistantFormulaEmpty: "empty",
	/** Formula helper — the assistant's formula was refused twice; the Try again button follows */
	assistantFormulaInvalid: "Not a valid formula.",
	/** Formula helper — the generation failed; the Try again button follows */
	assistantFormulaFailed: "Couldn't write a formula.",
	/** Formula helper — the model is not on this device yet; the Download button follows */
	assistantFormulaNotDownloaded: "Formulas are written on this device with the assistant's model, which isn't downloaded yet.",
	/** Formula helper — another cell was selected since asking; Insert is off. `cell` is where the formula was written for */
	assistantFormulaCellChanged: "Select {{cell}} again to insert the formula there.",
	/** Formula helper button — puts the formula into the formula bar, where Enter writes it to the cell */
	assistantFormulaInsert: "Insert",

	// ── Slides: whole text boxes ──────────────────────────────────────────────
	/** Slide context menu — submenu of what the assistant can do with the selected boxes or the slide */
	assistantMenuAssistant: "Assistant",
	/** Result over several text boxes — how many are done, e.g. "2 of 5" */
	assistantShapeTransformProgress: "{{done}} of {{total}}",
	/** Result — a box's name: a layout placeholder (title, body…), numbered in the slide's order */
	assistantShapeTransformPlaceholder: "Placeholder {{n}}",
	/** Result — a box's name: a text box, numbered in the slide's order */
	assistantShapeTransformTextBox: "Text box {{n}}",
	/** Result — a box's name: a shape with text, numbered in the slide's order */
	assistantShapeTransformShape: "Shape {{n}}",
	/** Result — the boxes left as they are; `boxes` lists them with the reason */
	assistantShapeTransformSkipped: "Not changed: {{boxes}}",
	/** Result — a box left out because it holds a field; `box` is its name */
	assistantShapeTransformSkipField: "{{box}} (holds a slide number, date or equation)",
	/** Result — a box left out because its text is too long; `box` is its name */
	assistantShapeTransformSkipTooLong: "{{box}} (too long)",
	/** Result — a box left out because it has no text; `box` is its name */
	assistantShapeTransformSkipEmpty: "{{box}} (no text)",
	/** Result — a box left out because its text could not be read; `box` is its name */
	assistantShapeTransformSkipUnreadable: "{{box}} (couldn't be read)",
	/** Result — a box's result failed or came back empty; Accept all is off. `box` is its name */
	assistantShapeTransformRowFailed: "{{box}}: couldn't do this. Try again.",
	/** Result — a box's result holds links or addresses its text did not; Accept all is off */
	assistantShapeTransformRowLinks: "{{box}} adds links or addresses its text didn't have: {{links}}. It can't be applied.",
	/** Result — a box's result stopped at its length limit; Accept all is off */
	assistantShapeTransformRowTruncated: "{{box}}: the result was cut off, so it can't be applied.",
	/** Result — a box was edited since asking; nothing was applied */
	assistantShapeTransformChanged: "The slide changed since you asked. Try again for a new result.",
	/** Result — applies every box's result as one change (one undo takes it back) */
	assistantShapeTransformAcceptAll: "Accept all",
	/** Toast — more boxes than one request takes; `count` is how many, `max` the most */
	assistantShapeTransformTooMany: "That's {{count}} text boxes; the assistant changes up to {{max}} at a time. Select fewer boxes.",
	/** Toast — nothing selected (or on the slide) holds text the assistant can change */
	assistantShapeTransformNothing: "There's no text here the assistant can change.",

	// ── Slides: speaker notes draft ───────────────────────────────────────────
	/** Empty notes pane button — drafts speaker notes from the slide's text */
	assistantNotesDraft: "Draft from slide",
	/** Slide context menu (Assistant submenu) — drafts speaker notes from the slide's text */
	assistantMenuDraftNotes: "Draft speaker notes",
	/** Notes pane — accessible name of the draft and its buttons */
	assistantNotesDraftLabel: "Speaker notes draft",
	/** Notes draft — the model is reading the slide, before the first word */
	assistantNotesDraftReading: "Reading the slide…",
	/** Notes draft — the model is not on this device yet; the Download button follows */
	assistantNotesDraftNotDownloaded: "Notes are drafted on this device with the assistant's model, which isn't downloaded yet.",
	/** Notes draft — the slide holds no text to draft from */
	assistantNotesDraftNoText: "This slide has no text to draft notes from.",
	/** Notes draft — the slide got notes since asking; Accept is off */
	assistantNotesDraftChanged: "This slide has notes now, so the draft can't be added.",
	/** Notes draft — the draft stopped at its length limit; Accept is off */
	assistantNotesDraftTruncated: "The draft was cut off, so it can't be added. Try again.",
	/** Notes draft — the draft holds links, addresses or numbers the slide does not; Accept is off. `items` lists them */
	assistantNotesDraftForeign: "This adds links, addresses or numbers the slide doesn't have: {{items}}. It can't be added."
} as const
