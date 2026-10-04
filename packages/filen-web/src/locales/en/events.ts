// English source catalog — "events" namespace: Settings → Events, the account's activity log — the list,
// its filters and search, the security summary, every event's sentence and the event detail dialog. The
// server keeps 30 days of events, so copy about absence says "in the last 30 days". Same typed-catalog
// rules as every other namespace: flat `as const` object, camelCase keys, no literal '.' or ':' (real
// i18next namespaces, keySeparator/nsSeparator both ON). "directory" never "folder".
export const events = {
	// ── List states ──────────────────────────────────────────────────────────
	/** Events list — the first page failed to load */
	eventsLoadError: "Couldn't load your events",
	/** Events list — empty state title */
	eventsEmptyTitle: "No events in the last 30 days",
	/** Events list — empty state description; the server keeps 30 days of events */
	eventsEmptyDescription: "Sign-ins, uploads, sharing and other activity on your account show up here. Events are kept for 30 days.",
	/** Events list — footer once every event of the 30-day window is loaded */
	eventsEndOfHistory: "That's everything from the last 30 days.",
	/** Deep link to an event that is not in the 30-day window (or doesn't exist) */
	eventsNotFound: "This event couldn't be found. Events are kept for 30 days.",
	/** Deep link to an event that failed to load (connection or server trouble), with a retry button */
	eventsDetailLoadError: "Couldn't load this event",
	/** Deep link to an event opened while offline; it loads once the connection returns */
	eventsDetailOffline: "You're offline. This event loads once you're back online.",

	// ── Filters and search ───────────────────────────────────────────────────
	/** Category chips — accessible name of the chip group */
	eventsCategoryFilterLabel: "Filter events by category",
	/** Category chip — every event */
	eventsCategoryAll: "All",
	/** Category chip — file events */
	eventsCategoryFiles: "Files",
	/** Category chip — directory events */
	eventsCategoryDirectories: "Directories",
	/** Category chip — shares and public links */
	eventsCategorySharing: "Sharing & links",
	/** Category chip — sign-ins, password and two-factor changes */
	eventsCategorySecurity: "Security",
	/** Category chip — email changes, codes, account deletion */
	eventsCategoryAccount: "Account",
	/** Search box placeholder; searches the loaded events */
	eventsSearchPlaceholder: "Search names, emails, IP addresses, devices",
	/** Search/filter matched nothing — title */
	eventsNoResultsTitle: "No matching events",
	/** Search/filter matched nothing — description */
	eventsNoResultsDescription: "Try another search or category.",
	/** Search/filter matched nothing among the events loaded so far; older ones may still match */
	eventsNoResultsLoadedDescription: "Nothing matches in the events loaded so far.",
	/** Reads older events for the current search or category after a few pages read by themselves */
	eventsSearchOlder: "Search older events",

	// ── Day headers ──────────────────────────────────────────────────────────
	/** Timeline day header — today */
	eventsDayToday: "Today",
	/** Timeline day header — yesterday */
	eventsDayYesterday: "Yesterday",

	// ── Security summary ─────────────────────────────────────────────────────
	/** Summary card above the list — title */
	eventsSummaryTitle: "Security at a glance",
	/** Summary card — last sign-in label */
	eventsSummaryLastSignIn: "Last sign-in",
	/** Summary card — no sign-in in the 30-day window */
	eventsSummaryNoSignIn: "None in the last 30 days",
	/** Summary card — failed sign-ins label */
	eventsSummaryFailedSignIns: "Failed sign-ins",
	/** Summary card — failed sign-in count over the last 7 days */
	eventsSummaryFailedSignInsCount_one: "{{count}} in the last 7 days",
	/** Summary card — failed sign-in count over the last 7 days */
	eventsSummaryFailedSignInsCount_other: "{{count}} in the last 7 days",
	/** Summary card — no failed sign-in over the last 7 days */
	eventsSummaryFailedSignInsNone: "None in the last 7 days",
	/** Summary card — password row label */
	eventsSummaryPassword: "Password",
	/** Summary card — password changed; the relative or absolute time follows after a separator */
	eventsSummaryPasswordChanged: "Changed",
	/** Summary card — two-factor row label */
	eventsSummaryTwoFactor: "Two-factor authentication",
	/** Summary card — two-factor last turned on; the relative or absolute time follows after a separator */
	eventsSummaryTwoFactorEnabled: "Turned on",
	/** Summary card — two-factor last turned off; the relative or absolute time follows after a separator */
	eventsSummaryTwoFactorDisabled: "Turned off",
	/** Summary card — no password or two-factor change in the 30-day window */
	eventsSummaryNotInWindow: "Not changed in the last 30 days",

	// ── Devices ──────────────────────────────────────────────────────────────
	/** Row badge — the first time this browser and operating system appear in the loaded events */
	eventsNewDevice: "New device",
	/** Tooltip on the new-device badge, while only part of the 30-day window is loaded */
	eventsNewDeviceHintWeek: "Not seen in the 7 days before this sign-in",
	/** Tooltip on the new-device badge, once the whole 30-day window is loaded */
	eventsNewDeviceHintWindow: "Not seen earlier in the last 30 days",
	/** Device label — a browser or app on an operating system, e.g. "Chrome on macOS" */
	eventsDeviceOnOs: "{{browser}} on {{os}}",
	/** Device label — nothing could be read from the user agent */
	eventsDeviceUnknown: "Unknown device",

	// ── Event sentences ──────────────────────────────────────────────────────
	/** {{name}} is a file name */
	eventsTitleUploaded: "Uploaded {{name}}",
	/** {{name}} is a file name */
	eventsTitleNewVersion: "Uploaded a new version of {{name}}",
	/** {{name}} is a file or directory name */
	eventsTitleRestoredFromTrash: "Restored {{name}} from the trash",
	/** An older version of the file became the current one; {{name}} is a file name */
	eventsTitleRestoredOlderVersion: "Restored an older version of {{name}}",
	/** {{name}} is a file or directory name */
	eventsTitleMoved: "Moved {{name}}",
	/** {{oldName}} → {{newName}} are the item's names before and after */
	eventsTitleRenamed: "Renamed {{oldName}} → {{newName}}",
	/** The item's details changed but not its name; {{name}} is a file or directory name */
	eventsTitleUpdated: "Updated {{name}}",
	/** {{name}} is a file or directory name */
	eventsTitleTrashed: "Moved {{name}} to the trash",
	/** An edit with versioning off replaced the file; {{name}} is a file name */
	eventsTitleReplaced: "Replaced {{name}} with a new version",
	/** {{name}} is a file name */
	eventsTitleDeleted: "Deleted {{name}}",
	/** {{name}} is a file or directory name */
	eventsTitleDeletedPermanently: "Permanently deleted {{name}}",
	/** Only the file's old versions were deleted; {{name}} is a file name */
	eventsTitleDeletedOldVersions: "Deleted old versions of {{name}}",
	/** {{name}} is a file or directory name; {{email}} a contact's name or an email address */
	eventsTitleShared: "Shared {{name}} with {{email}}",
	/** The event can't tell whether the link was turned on, off or edited; {{name}} is a file or directory name */
	eventsTitleLinkChanged: "Changed the public link of {{name}}",
	/** A directory link event names no directory */
	eventsTitleDirectoryLinkChanged: "Changed a public directory link",
	/** {{name}} is a directory name */
	eventsTitleCreated: "Created {{name}}",
	/** {{name}} is a directory name */
	eventsTitleColorChanged: "Changed the color of {{name}}",
	/** {{name}} is a file or directory name */
	eventsTitleFavorited: "Added {{name}} to favorites",
	/** {{name}} is a file or directory name */
	eventsTitleUnfavorited: "Removed {{name}} from favorites",
	/** Event sentence — a sign-in */
	eventsTitleSignedIn: "Signed in",
	/** Event sentence — a sign-in with a wrong password or code */
	eventsTitleFailedSignIn: "Failed sign-in attempt",
	/** Event sentence — the account password changed */
	eventsTitlePasswordChanged: "Changed your password",
	/** Event sentence — two-factor authentication turned on */
	eventsTitleTwoFactorEnabled: "Turned on two-factor authentication",
	/** Event sentence — two-factor authentication turned off */
	eventsTitleTwoFactorDisabled: "Turned off two-factor authentication",
	/** Event sentence — account deletion requested */
	eventsTitleAccountDeletionRequested: "Requested account deletion",
	/** Event sentence — the trash was emptied */
	eventsTitleTrashEmptied: "Emptied the trash",
	/** Event sentence — every file and directory was deleted */
	eventsTitleDeletedEverything: "Deleted all files and directories",
	/** Event sentence — every file's old versions were deleted */
	eventsTitleDeletedAllVersions: "Deleted all old file versions",
	/** Event sentence — unfinished uploads were deleted */
	eventsTitleDeletedUnfinished: "Deleted unfinished uploads",
	/** {{code}} is the redeemed code */
	eventsTitleCodeRedeemed: "Redeemed code {{code}}",
	/** {{email}} is the new email address */
	eventsTitleEmailChanged: "Changed your email address to {{email}}",
	/** {{email}} is the requested new email address */
	eventsTitleEmailChangeRequested: "Requested an email change to {{email}}",
	/** Items someone shared with this account were removed; {{email}} a contact's name or an email address */
	eventsTitleRemovedSharedIn_one: "Removed {{count}} item shared by {{email}}",
	/** Items someone shared with this account were removed; {{email}} a contact's name or an email address */
	eventsTitleRemovedSharedIn_other: "Removed {{count}} items shared by {{email}}",
	/** {{email}} is a contact's name or an email address */
	eventsTitleRemovedSharedOut_one: "Stopped sharing {{count}} item with {{email}}",
	/** {{email}} is a contact's name or an email address */
	eventsTitleRemovedSharedOut_other: "Stopped sharing {{count}} items with {{email}}",
	/** An event this app can't read; {{type}} is the server's raw event type */
	eventsTitleUnknown: "Unknown event ({{type}})",
	/** An event this app can't read, with no readable type either */
	eventsTitleUnknownUntyped: "Unknown event",
	/** Stands in for {{name}} when a file's name can't be read */
	eventsFallbackFile: "a file",
	/** Stands in for {{name}} when a directory's name can't be read */
	eventsFallbackDirectory: "a directory",
	/** Stands in for {{name}} when an item's name and type can't be read */
	eventsFallbackItem: "an item",
	/** Row second line — the directory an item is in; {{name}} is a directory name */
	eventsLocationIn: "in {{name}}",
	/** Row second line — the directory an item moved to; {{name}} is a directory name */
	eventsLocationTo: "to {{name}}",
	/** An undecodable event whose time can't be read */
	eventsUnknownTime: "Unknown time",
	/** Warning on a name with invisible or direction-changing characters */
	eventsMisleadingName: "This name has invisible or direction-changing characters; it may not be what it looks like.",

	// ── Detail dialog ────────────────────────────────────────────────────────
	/** Detail dialog — item section heading */
	eventsSectionItem: "Item",
	/** Detail dialog — device section heading */
	eventsSectionDevice: "Device",
	/** Detail dialog — identifiers section heading */
	eventsSectionDetails: "Details",
	/** Detail field — the item's name */
	eventsFieldName: "Name",
	/** A file's MIME type */
	eventsFieldType: "Type",
	/** Detail field — the file's size */
	eventsFieldSize: "Size",
	/** Detail field — the file's last-modified time */
	eventsFieldModified: "Modified",
	/** Detail field — the directory the item is in */
	eventsFieldLocation: "Location",
	/** Detail field — the name before a rename */
	eventsFieldPreviousName: "Previous name",
	/** Detail field — the name after a rename */
	eventsFieldNewName: "New name",
	/** Detail field — a directory's new color */
	eventsFieldColor: "Color",
	/** Detail field — a directory's previous color */
	eventsFieldPreviousColor: "Previous color",
	/** Detail field — whether the item was added to or removed from favorites */
	eventsFieldFavorite: "Favorite",
	/** Detail field — who the item was shared with */
	eventsFieldSharedWith: "Shared with",
	/** Detail field — who shared the items */
	eventsFieldSharedBy: "Shared by",
	/** Detail field — how many items */
	eventsFieldItems: "Items",
	/** Detail field — a redeemed code */
	eventsFieldCode: "Code",
	/** Detail field — an email address */
	eventsFieldEmail: "Email",
	/** Detail field — the email address before a change */
	eventsFieldPreviousEmail: "Previous email",
	/** Detail field — the email address after a change */
	eventsFieldNewEmail: "New email",
	/** A Filen app or HTTP client read from the user agent */
	eventsFieldApp: "App",
	/** Detail field — the browser read from the user agent */
	eventsFieldBrowser: "Browser",
	/** Detail field — the operating system read from the user agent */
	eventsFieldOperatingSystem: "Operating system",
	/** Detail field — the IP address the event came from */
	eventsFieldIpAddress: "IP address",
	/** Detail field — the raw user agent string */
	eventsFieldUserAgent: "User agent",
	/** The server's raw type of an event this app can't read */
	eventsFieldEventType: "Event type",
	/** Detail field — the event's identifier */
	eventsFieldEventId: "Event ID",
	/** Detail field — the file's or directory's identifier */
	eventsFieldItemId: "Item ID",
	/** Detail field — the public link's identifier */
	eventsFieldLinkId: "Link ID",
	/** Favorite field — the item was added to favorites */
	eventsValueFavoriteAdded: "Added",
	/** Favorite field — the item was removed from favorites */
	eventsValueFavoriteRemoved: "Removed",
	/** An item name or value that can't be decrypted */
	eventsValueEncrypted: "Encrypted",
	/** Copy button on a value */
	eventsActionCopy: "Copy",
	/** Copies every field of the event as text */
	eventsActionCopyDetails: "Copy details",
	/** Toast after a copy */
	eventsCopied: "Copied",
	/** Opens the directory the item is in */
	eventsActionOpenLocation: "Open location",
	/** Reveals the item in Cloud Drive */
	eventsActionShowInDrive: "Show in Cloud Drive",
	/** Show in Cloud Drive found nothing */
	eventsItemGone: "Item no longer exists",
	/** Expands the full user agent */
	eventsActionShowUserAgent: "Show full user agent",
	/** Collapses the full user agent */
	eventsActionHideUserAgent: "Hide full user agent",

	// dialog
	/** Detail field — the event's own UUID */
	eventsFieldEventUuid: "Event UUID",
	/** Detail field — a file's whole-life identifier, kept across renames and new versions */
	eventsFieldStableId: "Stable ID",
	/** Detail field — the kind of device read from the user agent */
	eventsFieldDeviceType: "Device type",
	/** Device type value */
	eventsValueDeviceDesktop: "Desktop",
	/** Device type value */
	eventsValueDeviceMobile: "Mobile",
	/** Device type value */
	eventsValueDeviceTablet: "Tablet",
	/** Accessible name of a value's copy button; {{field}} is the field's label */
	eventsActionCopyField: "Copy {{field}}",
	/** The server's raw data of an event this app can't read */
	eventsFieldRawEvent: "Raw event",
	/** Expands the raw data of an event this app can't read */
	eventsActionShowRawEvent: "Show raw event",
	/** Collapses the raw data of an event this app can't read */
	eventsActionHideRawEvent: "Hide raw event",

	// list
	/** No-results state — resets the search and the category */
	eventsClearFilters: "Clear search and filters"
} as const
