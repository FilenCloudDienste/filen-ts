// English source catalog — "sync" namespace: the desktop app's directory sync (the Sync section, its pair detail
// and the add-pair dialog). Same typed-catalog rules as every other namespace: flat `as const` object, camelCase
// keys, no literal '.' or ':'. "directory" never "folder"; the remote side is "the cloud".
export const sync = {
	// ── Sidebar ─────────────────────────────────────────────────────────
	/** Sidebar — add button and add-pair dialog title */
	syncAddPair: "Add sync pair",
	/** Sidebar — accessible name of the width drag handle */
	syncSidebarResize: "Resize sidebar",
	/** Sidebar — accessible name of the pair list */
	syncListLabel: "Sync pairs",
	/** Sidebar — no pairs yet */
	syncEmptyTitle: "No sync pairs",
	/** Sidebar — no pairs yet, under the title */
	syncEmptyDescription: "Keep a directory on this device and one in the cloud the same.",
	/** Sidebar row — a remote directory whose name could not be read */
	syncRemoteUnknown: "Unknown directory",

	/** Rail — accessible name of the Sync entry when a pair needs attention */
	railAttention: "Sync, needs attention",
	/** Rail — accessible name of the Sync entry while syncing */
	railSyncing: "Sync, syncing",

	// ── Host state banner ───────────────────────────────────────────────
	/** Host banner — the sync process is starting */
	hostStarting: "Starting sync…",
	/** Host banner — the sync process stopped and restarts on its own */
	hostRestarting: "Sync stopped unexpectedly and restarts shortly.",
	/** Host banner — the sync process kept crashing and was turned off */
	hostCrashLoop: "Sync kept stopping unexpectedly, so Filen turned it off.",
	/** Host banner — the sync component is missing from this install */
	hostAddonMissing: "Sync can't run because part of Filen is missing. Reinstall Filen if this keeps happening.",
	/** Host banner — another running Filen holds the sync data */
	hostBaselineInUse: "Another copy of Filen is using this account's sync data. Quit it and try again.",
	/** Host banner — the session could not be read from the system keychain */
	hostKeychainLocked: "Filen couldn't read your session from the system keychain. Unlock it and try again.",
	/** Host banner — retry button */
	hostRetry: "Try again",

	// ── Phases ──────────────────────────────────────────────────────────
	/** Pair phase — nothing to do */
	phaseIdle: "Up to date",
	/** Pair phase — a pass is running */
	phaseSyncing: "Syncing",
	/** Pair phase — paused by the user */
	phasePaused: "Paused",
	/** Pair phase — kept paused until the user checks its first run */
	phaseReview: "Needs review",
	/** Pair phase — its local directory is missing */
	phaseWaitingForRoot: "Directory missing",
	/** Pair phase — the engine refused it */
	phaseUnsupported: "Can't be synced",
	/** Pair phase — the last pass failed */
	phaseError: "Error",

	// ── Modes ───────────────────────────────────────────────────────────
	/** Sync mode — two-way */
	modeTwoWay: "Two-way",
	/** Sync mode — two-way, description */
	modeTwoWayDescription: "Changes on either side sync to the other, deletions too.",
	/** Sync mode — local to cloud */
	modeLocalToRemote: "This device to the cloud",
	/** Sync mode — local to cloud, description */
	modeLocalToRemoteDescription: "Changes on this device sync to the cloud. Changes in the cloud stay there.",
	/** Sync mode — cloud to local */
	modeRemoteToLocal: "The cloud to this device",
	/** Sync mode — cloud to local, description */
	modeRemoteToLocalDescription: "Changes in the cloud sync to this device. Changes on this device stay here.",
	/** Sync mode — local backup */
	modeLocalBackup: "Back up this device",
	/** Sync mode — local backup, description */
	modeLocalBackupDescription: "Files on this device are copied to the cloud. Nothing is ever deleted in the cloud.",
	/** Sync mode — cloud backup */
	modeRemoteBackup: "Back up the cloud",
	/** Sync mode — cloud backup, description */
	modeRemoteBackupDescription: "Files in the cloud are copied to this device. Nothing is ever deleted on this device.",

	// ── Detail ──────────────────────────────────────────────────────────
	/** Index — no pair selected */
	detailSelectPrompt: "Select a sync pair",
	/** Index — no pair selected, under the title */
	detailSelectPromptDescription: "Its activity, issues and settings show here.",
	/** Detail — a pair id that no longer exists */
	detailMissingTitle: "This sync pair no longer exists",
	/** Detail — tab bar accessible name */
	detailTabsLabel: "Sync pair sections",
	/** Detail — Activity tab */
	tabActivity: "Activity",
	/** Detail — Issues tab */
	tabIssues: "Issues",
	/** Detail — Ignored tab */
	tabIgnored: "Ignored",
	/** Detail — Settings tab */
	tabSettings: "Settings",
	/** Detail — progress of the running pass */
	detailProgress: "{{done}} of {{total}}",
	/** Detail — when the last pass finished; {{time}} is relative ("5 minutes ago") */
	detailLastSynced: "Last synced {{time}}",
	/** Detail — the local watcher fell back to periodic passes */
	detailDegradedLocal: "Filen can't watch this directory for changes, so it checks it every few minutes instead.",
	/** Detail — the remote watcher fell back to periodic passes */
	detailDegradedRemote: "Filen can't follow changes in the cloud directory live, so it checks it every few minutes instead.",
	/** Detail — the local directory is missing */
	detailWaitingForRoot: "The directory on this device is missing. Filen starts syncing it again once it's back.",
	/** Detail — pause the pair */
	detailPause: "Pause",
	/** Detail — resume the pair */
	detailResume: "Resume",
	/** Detail — sync now */
	detailSyncNow: "Sync now",
	/** Detail — local directory label */
	detailLocal: "On this device",
	/** Detail — remote directory label */
	detailRemote: "In the cloud",

	// ── Notices ─────────────────────────────────────────────────────────
	/** Notice — the old app's local trash is moved into the pair's bin */
	noticeLocalTrashMoved:
		"The previous app's local trash (.filen.trash.local) is moved into this pair's bin, .filen-sync-trash, when the pair first syncs. Items in the bin are deleted permanently after 30 days.",
	/** Notice — the local directory of a pair the previous app synced can't be a sync root */
	noticeRefusedLocalRoot:
		"Filen can't sync this pair from the previous app: its directory on this device can't be synced. Add it again with another directory.",
	/** Notice — the cloud directory of a pair the previous app synced is gone */
	noticeRefusedRemoteMissing:
		"Filen can't sync this pair from the previous app: its cloud directory no longer exists. Add it again with another cloud directory.",
	/** Notice — the local directory overlaps another pair's */
	noticeRefusedLocalOverlap:
		"Filen can't sync this pair: its directory on this device is, contains or is inside another pair's directory.",
	/** Notice — the cloud directory overlaps another pair's */
	noticeRefusedRemoteOverlap: "Filen can't sync this pair: its cloud directory is, contains or is inside another pair's cloud directory.",
	/** Notice — dismiss button */
	noticeDismiss: "Dismiss",
	/** Notice — remove the pair a refusal notice is about */
	noticeRemove: "Remove pair",

	// ── Activity ────────────────────────────────────────────────────────
	/** Activity — a file was uploaded */
	activityUploaded: "Uploaded",
	/** Activity — a file was downloaded */
	activityDownloaded: "Downloaded",
	/** Activity — a directory was created in the cloud */
	activityCreatedRemoteDirectory: "Created in the cloud",
	/** Activity — a directory was created on this device */
	activityCreatedLocalDirectory: "Created on this device",
	/** Activity — moved to the cloud trash */
	activityTrashedRemote: "Moved to the cloud trash",
	/** Activity — deleted on this device */
	activityDeletedLocal: "Deleted on this device",
	/** Activity — moved in the cloud */
	activityMovedRemote: "Moved in the cloud",
	/** Activity — moved on this device */
	activityMovedLocal: "Moved on this device",
	/** Activity — a replaced or deleted local file went to the pair's bin */
	activityBinned: "Moved to the bin",
	/** Activity — an item failed */
	activityFailed: "Failed",
	/** Activity — a conflict was found */
	activityConflict: "Conflict",
	/** Activity — deletions were held for approval */
	activityDeletionsHeld: "Deletions held for approval",
	/** Activity — a pass failed */
	activityPassFailed: "Sync failed",
	/** Activity — a pass finished */
	activityPassCompleted: "Sync finished",
	/** Activity — list accessible name */
	activityListLabel: "Recent activity",
	/** Activity — nothing yet */
	activityEmptyTitle: "No activity yet",
	/** Activity — nothing yet, under the title */
	activityEmptyDescription: "What Filen syncs while it runs shows up here.",
	/** Activity — heading over the transfers in progress */
	activityNowSyncing: "Now syncing",
	/** Activity — a move's destination */
	activityMovedTo: "to {{path}}",

	// ── Issues ──────────────────────────────────────────────────────────
	/** Issues — nothing to resolve */
	issuesEmptyTitle: "No issues",
	/** Issues — nothing to resolve, under the title */
	issuesEmptyDescription: "Conflicts, held deletions and items that can't be synced show up here.",
	/** Issues — the last pass's error */
	issuesLastError: "Last error",
	/** Issues — items that failed in the last pass */
	issuesFailed_one: "{{count}} item failed in the last sync. Filen tries it again in the next one.",
	/** Issues — items that failed in the last pass */
	issuesFailed_other: "{{count}} items failed in the last sync. Filen tries them again in the next one.",
	/** Issues — conflicts section */
	issuesConflictsTitle: "Conflicts",
	/** Issues — conflicts section description */
	issuesConflictsDescription: "These changed on both sides. Choose which version to keep.",
	/** Conflict — changed on both sides */
	conflictBoth: "Changed on both sides",
	/** Conflict — deleted on this device, changed in the cloud */
	conflictLocalDeleted: "Deleted on this device, changed in the cloud",
	/** Conflict — deleted in the cloud, changed on this device */
	conflictRemoteDeleted: "Deleted in the cloud, changed on this device",
	/** Conflict — keep the local version */
	conflictKeepLocal: "Keep this device's",
	/** Conflict — keep the cloud version */
	conflictKeepRemote: "Keep the cloud's",
	/** Conflict — keep both */
	conflictKeepBoth: "Keep both",
	/** Toast — keep both renamed the local copy */
	conflictKeptBoth: "Kept both. This device's copy is now {{path}}.",
	/** Issues — held deletions section */
	heldTitle: "Held deletions",
	/** Issues — approve the held deletions */
	heldApprove: "Approve deletions",
	/** Held deletions — confirm title */
	heldApproveTitle: "Approve these deletions?",
	/** Held deletions — confirm body */
	heldApproveBody_one:
		"{{count}} item is deleted on the other side. This device's deletions go to the pair's bin, the cloud's to the cloud trash.",
	/** Held deletions — confirm body */
	heldApproveBody_other:
		"{{count}} items are deleted on the other side. This device's deletions go to the pair's bin, the cloud's to the cloud trash.",
	/** Held deletions — how many more are not listed */
	heldMore: "and {{count}} more",
	/** Held reason — a scan did not finish */
	heldScanIncomplete: "Filen held these deletions because a scan didn't finish.",
	/** Held reason — the first sync would delete */
	heldFirstSyncWithDeletions: "Filen held these deletions because they're part of this pair's first sync.",
	/** Held reason — the cloud side was not fully read */
	heldRemoteUnconverged: "Filen held these deletions because it hadn't fully read the cloud directory.",
	/** Held reason — the cloud directory was emptied */
	heldRemoteEmptied: "Filen held these deletions because the cloud directory was emptied.",
	/** Held reason — too many at once */
	heldExceededThreshold: "Filen held these deletions because there are unusually many at once.",
	/** Issues — unsyncable section */
	unsyncableTitle: "Can't be synced",
	/** Unsyncable — retry one item */
	unsyncableRetry: "Retry",
	/** Unsyncable — invalid local name */
	unsyncableInvalidName: "Its name isn't allowed in the cloud.",
	/** Unsyncable — kept failing */
	unsyncableRepeatedFailure: "It failed several times in a row.",
	/** Unsyncable — the cloud item cannot be decrypted */
	unsyncableRemoteUndecodable: "The cloud item can't be decrypted.",
	/** Unsyncable — invalid cloud name */
	unsyncableRemoteInvalidName: "Its cloud name isn't allowed on this device.",
	/** Unsyncable — its cloud parent is broken */
	unsyncableRemoteBrokenParent: "The cloud directory it's in can't be read.",
	/** Unsyncable — two local names refer to the same file */
	unsyncableLocalAlias: "Another name on this device refers to the same file.",
	/** Paged lists — load the next page */
	listLoadMore: "Load more",
	/** Paged lists — load failure */
	listLoadError: "Couldn't load this list.",
	/** Paged lists — empty */
	listEmpty: "Nothing here",

	// ── Ignored ─────────────────────────────────────────────────────────
	/** Ignored — this pair's ignored paths */
	ignoredTitle: "Ignored in this pair",
	/** Ignored — section description */
	ignoredDescription: "These paths aren't synced because a rule matches them.",
	/** Ignored — built-in rule */
	ignoredLevelDefault: "Built-in rule",
	/** Ignored — the user's device-wide rule */
	ignoredLevelUser: "Your rule",
	/** Ignored — a .filenignore file; {{dir}} is its directory in the pair */
	ignoredLevelFile: ".filenignore in {{dir}}",
	/** Ignored — the .filenignore in the pair's own directory */
	ignoredLevelFileRoot: ".filenignore in the pair's directory",
	/** Ignored — the path was synced before the rule */
	ignoredTracked: "Synced before",
	/** Device-wide ignore rules — title */
	userIgnoreTitle: "Ignore rules",
	/** Device-wide ignore rules — description */
	userIgnoreDescription: "Applies to every sync pair on this device. One rule per line, written like a .gitignore.",
	/** Device-wide ignore rules — the built-in rules, read-only */
	userIgnoreDefaults: "Built-in rules",
	/** Device-wide ignore rules — save */
	userIgnoreSave: "Save rules",
	/** Toast — rules saved */
	userIgnoreSaved: "Ignore rules saved",
	/** Device-wide ignore rules — a line that does not parse */
	userIgnoreInvalidLine: "Line {{line}} isn't a valid rule.",

	// ── Settings tab ────────────────────────────────────────────────────
	/** Settings — pair group */
	settingsGroupPair: "Pair",
	/** Settings — syncing group */
	settingsGroupSyncing: "Syncing",
	/** Settings — danger group */
	settingsGroupDanger: "Remove",
	/** Settings — name row */
	settingsName: "Name",
	/** Settings — save the name */
	settingsNameSave: "Rename",
	/** Settings — local directory row */
	settingsLocal: "Directory on this device",
	/** Settings — remote directory row */
	settingsRemote: "Directory in the cloud",
	/** Settings — show the local directory */
	settingsRevealAction: "Show",
	/** Settings — the pair's bin row */
	settingsBin: "Bin",
	/** Settings — the pair's bin description */
	settingsBinDescription:
		"Items the sync replaces or deletes on this device are filed by date in .filen-sync-trash in the pair's directory and deleted permanently after 30 days.",
	/** Settings — mode row */
	settingsMode: "Sync mode",
	/** Settings — pause row */
	settingsPause: "Pause syncing",
	/** Settings — pause row description */
	settingsPauseDescription: "A paused pair keeps its state and catches up when it resumes.",
	/** Settings — pause button */
	settingsPauseAction: "Pause",
	/** Settings — resume button */
	settingsResumeAction: "Resume",
	/** Settings — sync now row */
	settingsSyncNow: "Sync now",
	/** Settings — sync now row description */
	settingsSyncNowDescription: "Check both sides for changes right away.",
	/** Settings — remove row */
	settingsRemove: "Remove sync pair",
	/** Settings — remove row description */
	settingsRemoveDescription: "Stop syncing these directories. The files stay on both sides.",
	/** Settings — remove button */
	settingsRemoveAction: "Remove",

	// ── Remove dialog ───────────────────────────────────────────────────
	/** Remove dialog — title; {{name}} is the pair */
	removeTitle: "Remove {{name}}?",
	/** Remove dialog — body */
	removeBody: "Filen stops syncing this pair. The files stay on this device and in the cloud.",

	// ── Backlog dialog ──────────────────────────────────────────────────
	/** Backlog dialog — title */
	backlogTitle: "Leave backup mode",
	/** Backlog dialog — description */
	backlogDescription:
		"As a backup, this pair kept copies in the destination of files you deleted from the source. What should happen to them?",
	/** Backlog — propagate the deletions the backup held back */
	backlogPropagate: "Delete them from the destination",
	/** Backlog — propagate, description */
	backlogPropagateDescription: "The destination matches the source after the next sync. Large deletions still ask first.",
	/** Backlog — adopt the destination's standing copies */
	backlogAdoptDestination: "Keep them in the destination",
	/** Backlog — adopt, description */
	backlogAdoptDestinationDescription: "The kept copies stay where they are and are not deleted or copied back to the source.",
	/** Backlog dialog — confirm */
	backlogConfirm: "Change mode",

	// ── Review card ─────────────────────────────────────────────────────
	/** Review — title for a new pair */
	reviewTitleNew: "Before the first sync",
	/** Review — description for a new pair */
	reviewDescriptionNew: "This is what the first sync does. Nothing changes until you start it.",
	/** Review — title for a pair moved from the previous desktop app */
	reviewTitleMigrated: "Check this pair before it starts",
	/** Review — description for a moved pair */
	reviewDescriptionMigrated:
		"Filen brought this pair over from the previous desktop app and kept it paused, because its first sync would do more than expected.",
	/** Review — title after the sync state was rebuilt */
	reviewTitleBaselineReset: "Check this pair before it starts again",
	/** Review — description after the sync state was rebuilt */
	reviewDescriptionBaselineReset:
		"Filen had to rebuild this pair's sync state, so it kept the pair paused until you check its next sync.",
	/** Finding — uploads */
	findingUploads: "It uploads more than a few small files.",
	/** Finding — downloads */
	findingDownloads: "It downloads more than a few small files.",
	/** Finding — conflicts */
	findingConflicts: "Some items changed on both sides.",
	/** Finding — held deletions */
	findingHeldDeletions: "It deletes items.",
	/** Finding — refused */
	findingRefused: "It can't sync as it is.",
	/** Finding — newly synced */
	findingNewlySynced: "It syncs items the previous app ignored.",
	/** Finding — unconverged */
	findingUnconverged: "Filen hadn't fully read the cloud directory yet.",
	/** Finding — per-pair dot files */
	findingDotFilesPerPair:
		"The previous app ignored hidden files for this pair only. Filen added a .filenignore to its directory that keeps them ignored, and that file syncs to your other devices.",
	/** Review — changes count */
	reviewActions_one: "{{count}} change",
	/** Review — changes count */
	reviewActions_other: "{{count}} changes",
	/** Review — bytes to upload */
	reviewUpload: "{{size}} to upload",
	/** Review — bytes to download */
	reviewDownload: "{{size}} to download",
	/** Review — held deletions count */
	reviewHeld_one: "{{count}} deletion held for approval",
	/** Review — held deletions count */
	reviewHeld_other: "{{count}} deletions held for approval",
	/** Review — conflicts count */
	reviewConflicts_one: "{{count}} conflict",
	/** Review — conflicts count */
	reviewConflicts_other: "{{count}} conflicts",
	/** Review — unsyncable count */
	reviewUnsyncable_one: "{{count}} item can't be synced",
	/** Review — unsyncable count */
	reviewUnsyncable_other: "{{count}} items can't be synced",
	/** Review — ignored count */
	reviewIgnored_one: "{{count}} item ignored",
	/** Review — ignored count */
	reviewIgnored_other: "{{count}} items ignored",
	/** Refusal — two cloud items map to one local path */
	refusedRemoteCollision: "Two items in the cloud directory would get the same name on this device. Rename one of them first.",
	/** Refusal — two local items map to one cloud path */
	refusedLocalCollision: "Two items in this directory would get the same name in the cloud. Rename one of them first.",
	/** Review — no plan yet */
	reviewUnconverged: "Filen is still reading the cloud directory, so what the first sync does isn't known yet.",
	/** Review — a very large first sync; {{formatted}} is the formatted number of changes */
	reviewLarge: "This sync makes {{formatted}} changes. It can take a long time and use a lot of bandwidth.",
	/** Review — start */
	reviewStart: "Start syncing",
	/** Review — keep paused */
	reviewKeepPaused: "Keep paused",
	/** Review — remove */
	reviewRemove: "Remove pair",
	/** Review — show what the plan does */
	reviewShowDetails: "Show changes",
	/** Review — the preview expired */
	reviewPlanExpired: "This preview expired.",
	/** Review — fetch a new preview */
	reviewRefresh: "Refresh",
	/** Review — plan lists accessible name */
	reviewListsLabel: "Planned changes",
	/** Plan list — changes */
	planListActions: "Changes",
	/** Plan list — held deletions */
	planListHeld: "Held deletions",
	/** Plan list — conflicts */
	planListConflicts: "Conflicts",
	/** Plan list — unsyncable */
	planListUnsyncable: "Can't be synced",
	/** Plan list — ignored */
	planListIgnored: "Ignored",
	/** Plan action — upload */
	actionUpload: "Upload",
	/** Plan action — download */
	actionDownload: "Download",
	/** Plan action — create a cloud directory */
	actionCreateRemoteDirectory: "Create in the cloud",
	/** Plan action — create a local directory */
	actionCreateLocalDirectory: "Create on this device",
	/** Plan action — move in the cloud */
	actionMoveRemote: "Move in the cloud",
	/** Plan action — move on this device */
	actionMoveLocal: "Move on this device",
	/** Plan action — cloud trash */
	actionTrashRemote: "Move to the cloud trash",
	/** Plan action — local delete */
	actionDeleteLocal: "Delete on this device",
	/** Plan action — already the same on both sides */
	actionAdoptBaseline: "Already the same",

	// ── Errors ──────────────────────────────────────────────────────────
	/** Error — the sync process is not running */
	errorHostUnavailable: "Sync isn't running right now.",
	/** Error — no answer in time */
	errorTimeout: "Sync didn't answer in time. Try again.",
	/** Error — the session was rejected */
	errorUnauthenticated: "Your session expired. Sign in again.",
	/** Error — unknown pair */
	errorPairNotFound: "This sync pair no longer exists.",
	/** Error — the preview expired */
	errorPlanExpired: "This preview expired. Refresh it.",
	/** Error — the chosen local directory expired */
	errorRootExpired: "The chosen directory expired. Choose it again.",
	/** Error — the local directory was refused */
	errorRootRefused: "This directory can't be synced.",
	/** Error — the local directory is gone */
	errorLocalRootMissing: "The directory on this device is missing.",
	/** Error — the cloud directory is gone */
	errorRemoteRootMissing: "The cloud directory no longer exists.",
	/** Error — local directory used by another pair */
	errorLocalRootInUse: "Another sync pair already uses this directory.",
	/** Error — local directory inside another pair */
	errorLocalRootNested: "This directory is inside another sync pair's directory.",
	/** Error — local directory contains another pair */
	errorLocalRootContains: "This directory contains another sync pair's directory.",
	/** Error — cloud directory used by another pair */
	errorRemoteRootInUse: "Another sync pair already uses this cloud directory.",
	/** Error — cloud directory inside another pair */
	errorRemoteRootNested: "This cloud directory is inside another sync pair's cloud directory.",
	/** Error — cloud directory contains another pair */
	errorRemoteRootContains: "This cloud directory contains another sync pair's cloud directory.",
	/** Error — the mode change cannot apply */
	errorModeConflict: "The pair can't switch to this mode right now.",
	/** Error — an ignore rule does not parse */
	errorInvalidIgnore: "An ignore rule isn't valid.",
	/** Error — anything else */
	errorUnknown: "Something went wrong with sync.",

	// ── Local directory problems and warnings ───────────────────────────
	/** Local directory refused — not a directory */
	problemNotDirectory: "This isn't a directory.",
	/** Local directory refused — read-only */
	problemNotWritable: "Filen can't write to this directory.",
	/** Local directory refused — a drive's root */
	problemFilesystemRoot: "A whole drive can't be synced. Choose a directory on it.",
	/** Local directory refused — the home directory itself */
	problemHomeDirectory: "Your home directory can't be synced. Choose a directory inside it.",
	/** Local directory refused — app data */
	problemAppData: "Directories that apps keep their data in can't be synced.",
	/** Local directory refused — temporary files */
	problemTemporary: "Temporary directories can't be synced.",
	/** Local directory refused — inside another pair */
	problemInsidePair: "This directory is inside another sync pair's directory.",
	/** Local directory refused — contains another pair */
	problemContainsPair: "This directory contains another sync pair's directory.",
	/** Local directory refused — inside a network drive */
	problemInsideMount: "This directory is inside a Filen network drive.",
	/** Local directory refused — contains a network drive */
	problemContainsMount: "This directory contains a Filen network drive.",
	/** Local directory warning — iCloud Drive */
	warningICloud: "This directory is in iCloud Drive. iCloud and Filen would both sync its files, which can cause conflicts.",
	/** Local directory warning — another cloud app (macOS CloudStorage) */
	warningCloudStorage: "Another cloud storage app syncs this directory. Both apps would sync its files, which can cause conflicts.",
	/** Local directory warning — OneDrive */
	warningOneDrive: "This directory is in OneDrive. OneDrive and Filen would both sync its files, which can cause conflicts.",

	// ── Add-pair dialog ─────────────────────────────────────────────────
	/** Add — step counter */
	addStep: "Step {{step}} of {{total}}",
	/** Add — local step title */
	addLocalTitle: "Directory on this device",
	/** Add — local step description */
	addLocalDescription: "Choose the directory to keep in sync.",
	/** Add — choose the local directory */
	addChooseLocal: "Choose directory",
	/** Add — choose a different local directory */
	addChooseOtherLocal: "Choose another",
	/** Add — remote step title */
	addRemoteTitle: "Directory in the cloud",
	/** Add — remote step description */
	addRemoteDescription: "Open the directory in your Cloud Drive to sync with. Double-click a directory to open it.",
	/** Add — remote filter placeholder */
	addRemoteFilter: "Filter directories",
	/** Add — the remote pick */
	addRemotePick: "Syncs with {{name}}",
	/** Add — mode step title */
	addModeTitle: "Sync mode",
	/** Add — mode step description */
	addModeDescription: "Choose how changes move between the two directories. You can change this later.",
	/** Add — name step title */
	addNameTitle: "Name",
	/** Add — name step description */
	addNameDescription: "Shown in the sync list.",
	/** Add — next step */
	addNext: "Next",
	/** Add — previous step */
	addBack: "Back",
	/** Add — create the pair */
	addCreate: "Add pair",
	/** Toast — the pair started */
	addStarted: "Sync started"
} as const
