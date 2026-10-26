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
	/** Unavailable reason — not enough free storage for the download */
	assistantUnavailableInsufficientStorage: "There isn't enough free storage on this device for the assistant's model.",
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
	/** Step — the request was understood as being about the trash */
	assistantStepRoutedTrash: "Working with the trash",
	/** Step — the request was understood as being about notes */
	assistantStepRoutedNotes: "Working with your notes",
	/** Step — the request was understood as being about chats */
	assistantStepRoutedChats: "Working with your chats",
	/** Step — the request was understood as being about music playback */
	assistantStepRoutedAudio: "Working with your music",
	/** Step — the request was understood as opening a part of the app */
	assistantStepRoutedNavigation: "Working with the app",
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
	/** Step — trash_items; subject is the item's name */
	assistantStepTrashItems: 'Moving "{{subject}}" to the trash',
	/** Step — list_notes; subject is the search text */
	assistantStepListNotes: 'Searching notes for "{{subject}}"',
	/** Step — read_note; subject is the note's title */
	assistantStepReadNote: 'Reading the note "{{subject}}"',
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
	/** Activity — trash_items */
	assistantToolTrashItems: "Moving items to the trash",
	/** Activity — list_notes */
	assistantToolListNotes: "Listing your notes",
	/** Activity — read_note */
	assistantToolReadNote: "Reading a note",
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
	/** Card field — the target directory of a move, copy or create */
	assistantProposalDestination: "In",
	/** Card field — the new name of a rename or create */
	assistantProposalName: "Name",
	/** Card field — any other free-text argument */
	assistantProposalText: "Text",
	/** Card — accessible name of the affected-items list */
	assistantProposalItems: "Items",
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
	assistantStop: "Stop"
} as const
