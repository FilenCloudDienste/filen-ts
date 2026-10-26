// English source catalog — "videos" namespace: the /videos screens, the Videos sidebar and phone tabs, the
// directory chooser and the Libraries dialog. Same typed-catalog rules as every namespace: flat `as const`
// object, camelCase keys, no literal '.' or ':'. The module's own name is common:moduleVideos.
export const videos = {
	// ── Navigation ─────────────────────────────────────────────────────────────
	/** Sidebar + phone tabs — the library's home */
	videosHome: "Home",
	/** Sidebar + phone tabs — every movie in the library */
	videosMovies: "Movies",
	/** Sidebar + phone tabs — every series in the library */
	videosShows: "Shows",
	/** Sidebar — videos that are neither a movie nor an episode; listed only when there are some */
	videosOther: "Other",
	/** Phone tabs — searching the library */
	videosSearch: "Search",
	/** Sidebar — header over the list of library directories */
	videosLibrariesGroup: "Libraries",
	/** Sidebar footer, header button — opens the Libraries dialog */
	videosManageLibraries: "Manage libraries",
	/** Sidebar header icon button, first-run button, Libraries dialog footer — opens the directory chooser */
	videosAddDirectory: "Add a directory",
	/** Sidebar — accessible label of the drag handle that resizes the panel */
	videosSidebarResize: "Resize sidebar",
	/** Sidebar library row — screen-reader text replacing the count while the directory is scanned */
	videosRootScanning: "Scanning",
	/** Sidebar library row — screen-reader text replacing the count when the latest scan didn't finish */
	videosRootIncomplete: "Incomplete",
	/** Sidebar library row — screen-reader text replacing the count when the directory can't be found */
	videosRootMissing: "Not found",
	/** Sidebar row — screen-reader form of a count shown as a bare number (singular) */
	videosCountTitles_one: "{{count, number}} title",
	/** Sidebar row — screen-reader form of a count shown as a bare number (plural) */
	videosCountTitles_other: "{{count, number}} titles",

	// ── First run ──────────────────────────────────────────────────────────────
	/** First run — title before any directory is part of the library */
	videosFirstRunTitle: "Add a directory to build your library",
	/** First run — what the library is made from */
	videosFirstRunBody: "Titles come from file and directory names. Nothing is uploaded or sent anywhere.",
	/** First run — hint under the button */
	videosFirstRunHint: "You can add more directories later, for example one for movies and one for shows.",
	/** Every directory is turned off in Libraries — title */
	videosAllOffTitle: "No directory is included",
	/** Every directory is turned off in Libraries — body */
	videosAllOffBody: "Turn one on in Libraries, or add another directory.",

	// ── Scanning ───────────────────────────────────────────────────────────────
	/** Scan status line — one directory being scanned; {{name}} = directory name. No count: a scan is one request whose result arrives at once */
	videosScanning: "Scanning “{{name}}”…",
	/** Scan status line — several directories being scanned (singular remainder) */
	videosScanningMore_one: "Scanning “{{name}}” and {{count, number}} more…",
	/** Scan status line — several directories being scanned (plural remainder) */
	videosScanningMore_other: "Scanning “{{name}}” and {{count, number}} more…",
	/** Scan status line — button that stops showing the scan; the previous library stays */
	videosStopScan: "Stop",
	/** Scan status line — accessible label of the Stop button */
	videosStopScanLabel: "Stop scanning",
	/** Scan status line — retries directories whose scan never started */
	videosRetryScan: "Retry",
	/** Screen-reader announcement once a directory's scan finished (singular) */
	videosScanDone_one: "{{name}} scanned: {{count, number}} video",
	/** Screen-reader announcement once a directory's scan finished (plural) */
	videosScanDone_other: "{{name}} scanned: {{count, number}} videos",
	/** Empty library — the only directory holds no video files; {{name}} = directory name */
	videosRootEmptyTitle: "No video files found in {{name}}",
	/** Empty library — several directories, none holding video files */
	videosLibraryEmptyTitle: "No video files found",
	/** Empty library — body */
	videosLibraryEmptyBody: "Video files anywhere inside a library directory, including its subdirectories, show up here.",
	/** Button — scans a directory again */
	videosRescan: "Rescan",
	/** Empty library — opens the chooser to replace the empty directory with another */
	videosChooseAnother: "Choose another",
	/** Banner — a directory's latest scan didn't finish; an earlier complete scan is shown; {{name}} = directory name */
	videosIncompleteBanner: "{{name}}: library incomplete. Showing the last complete scan.",
	/** Banner — a directory's first scan didn't finish, so nothing of it is shown */
	videosIncompleteBannerNoScan: "{{name}}: library incomplete. The scan didn't finish.",
	/** Banner — a library directory can't be found any more */
	videosMissingBanner: "{{name}} can't be found. It may have been moved to the trash or deleted.",

	// ── Libraries dialog ───────────────────────────────────────────────────────
	/** Libraries dialog — title */
	videosLibrariesTitle: "Libraries",
	/** Libraries dialog — description under the title */
	videosLibrariesDescription: "Each directory is read by name only. Watch progress syncs to your account.",
	/** Libraries dialog — shown when the library has no directory yet */
	videosLibrariesNone: "No directory is part of your library yet.",
	/** Libraries dialog — accessible label of a directory's include switch */
	videosLibraryInclude: "Include {{name}} in Videos",
	/** Libraries dialog — label of a directory's type select */
	videosLibraryType: "Type",
	/** Type select — classify each title by its names */
	videosTypeAuto: "Auto",
	/** Type select — auto, with what the names were classified as; {{kind}} = Movies, Shows or Other */
	videosTypeAutoDetected: "Auto: {{kind}}",
	/** Type select — every title is a movie */
	videosTypeMovies: "Movies",
	/** Type select — every title is a series */
	videosTypeShows: "Shows",
	/** Type select — no movie or series matching */
	videosTypeOther: "Other",
	/** Libraries dialog subline — video count (singular) */
	videosLibraryVideos_one: "{{count, number}} video",
	/** Libraries dialog subline — video count (plural) */
	videosLibraryVideos_other: "{{count, number}} videos",
	/** Libraries dialog subline — series count (singular) */
	videosLibraryShows_one: "{{count, number}} show",
	/** Libraries dialog subline — series count (plural) */
	videosLibraryShows_other: "{{count, number}} shows",
	/** Libraries dialog subline — path, counts and scan; {{path}} = directory path, {{counts}} and {{scan}} = the parts below */
	videosLibrarySubline: "{{path}} · {{counts}} · {{scan}}",
	/** Libraries dialog subline — a turned-off directory */
	videosLibrarySublineOff: "{{path}} · not included",
	/** Libraries dialog subline — video and series counts together */
	videosLibraryCountsWithShows: "{{videos}} · {{shows}}",
	/** Libraries dialog subline — when the last complete scan began; {{time}} = relative time */
	videosLibraryScanned: "last scan: {{time}}",
	/** Libraries dialog subline — the directory was never scanned completely */
	videosLibraryNotScanned: "not scanned yet",
	/** Libraries dialog — the directory is being scanned */
	videosLibraryScanning: "Scanning",
	/** Libraries dialog — the latest scan didn't finish, an earlier one is shown */
	videosLibraryIncomplete: "Library incomplete: the last scan didn't finish. Showing the previous one.",
	/** Libraries dialog — the first scan didn't finish */
	videosLibraryIncompleteNoScan: "Library incomplete: the scan didn't finish.",
	/** Libraries dialog — the directory can't be found */
	videosLibraryMissing: "Not found. It may have been moved to the trash or deleted.",
	/** Libraries dialog — the directory was moved since it was added */
	videosLibraryMoved: "Moved since it was added.",
	/** Libraries dialog — a large directory; {{files, number}} = files and directories it holds */
	videosLibrarySizeLarge: "About {{files, number}} files. Scanning it uses a lot of memory.",
	/** Libraries dialog — a very large directory */
	videosLibrarySizeHuge: "About {{files, number}} files. Scanning it can run out of memory; a narrower directory is lighter.",
	/** Libraries dialog — accessible label of a directory's menu trigger */
	videosLibraryMenu: "More options for {{name}}",
	/** Libraries dialog menu — opens the directory in Cloud Drive */
	videosOpenInDrive: "Open in Cloud Drive",
	/** Libraries dialog menu — removes the directory from Videos */
	videosRemoveRoot: "Remove from Videos",
	/** Remove confirmation — title */
	videosRemoveConfirmTitle: "Remove {{name}}?",
	/** Remove confirmation — body */
	videosRemoveConfirmBody: "Removes {{name}} from Videos only. Files and watch progress stay.",
	/** Remove confirmation — confirm button */
	videosRemoveConfirmAction: "Remove",
	/** Libraries dialog — footer button closing it */
	videosLibrariesDone: "Done",

	// ── Directory chooser ──────────────────────────────────────────────────────
	/** Chooser — title */
	videosChooserTitle: "Add a directory to Videos",
	/** Chooser — filter input placeholder and accessible label */
	videosChooserFilterPlaceholder: "Filter directories",
	/** Chooser — confirm button adding the open directory; {{name}} = its name */
	videosChooserConfirm: "Add “{{name}}”",
	/** Chooser row — the directory is already a library directory */
	videosChooserAlreadyRoot: "Already in Videos",
	/** Chooser — the open directory sits inside a library directory; {{name}} = that directory */
	videosChooserInsideRoot: "Inside {{name}}",
	/** Chooser — the open directory overlaps library directories; {{names}} = their names */
	videosChooserReplaceBody: "Library directories can't overlap. Adding {{name}} replaces {{names}}.",
	/** Chooser — confirm a replacement */
	videosChooserReplaceAction: "Replace",
	/** Chooser — the open directory is Filen's own */
	videosChooserSystemDirectory: "This directory belongs to Filen and can't be added.",
	/** Chooser — the open directory can't be found any more */
	videosChooserNotFound: "This directory can't be found any more.",
	/** Chooser — the open directory is very large; {{files, number}} = files and directories inside */
	videosChooserLargeBody:
		"{{name}} holds about {{files, number}} files. Scanning it uses a lot of memory; a narrower directory, such as one for movies and one for shows, is lighter.",
	/** Chooser — add a large directory anyway */
	videosChooserLargeAction: "Add anyway",
	/** Chooser — leaves a warning and goes back to browsing */
	videosChooserBack: "Back",

	// ── Home ───────────────────────────────────────────────────────────────────
	/** Home row — what was started and not finished, plus the next episode of shows being watched */
	videosHomeContinueWatching: "Continue Watching",
	/** Home row — movies newest first */
	videosHomeLatestMovies: "Recently Added Movies",
	/** Home row — episodes newest first */
	videosHomeLatestEpisodes: "Recently Added Episodes",
	/** Home row header link — opens the row's full library view */
	videosHomeSeeAll: "See all",
	/** Home row header link — accessible name; {{row}} = the row's heading */
	videosHomeSeeAllLabel: "See all {{row}}",
	/** Home row — chevron scrolling the row back */
	videosHomeScrollBack: "Scroll back",
	/** Home row — chevron scrolling the row forward */
	videosHomeScrollForward: "Scroll forward",
	/** Home hero — play button */
	videosHomePlay: "Play",
	/** Home hero — resume button; {{time}} = position, e.g. 42:10 */
	videosHomeResume: "Resume {{time}}",
	/** Home hero metadata — runtime in hours and minutes */
	videosHomeRuntimeHours: "{{hours}}h {{minutes}}m",
	/** Home hero metadata — runtime under an hour */
	videosHomeRuntimeMinutes: "{{minutes}}m",
	/** Home hero metadata — when playback started now would end; {{time}} = clock time */
	videosHomeEndsAt: "Ends at {{time}}",
	/** Home hero metadata — high dynamic range */
	videosHomeHdr: "HDR",

	// ── Cards ──────────────────────────────────────────────────────────────────
	/** Card subline — episode code and title, e.g. "S2E5 · Woe's Hollow" */
	videosCardEpisodeTitled: "{{code}} · {{title}}",
	/** Card subline — time left of a started video (singular) */
	videosCardMinutesLeft_one: "{{count, number}} min left",
	/** Card subline — time left of a started video (plural) */
	videosCardMinutesLeft_other: "{{count, number}} min left",
	/** Card subline — the next episode of a show being watched */
	videosCardUpNext: "Up next",
	/** Card subline — episodes recently added to one season (singular) */
	videosCardSeasonNew_one: "Season {{season}} · {{count, number}} episode added",
	/** Card subline — episodes recently added to one season (plural) */
	videosCardSeasonNew_other: "Season {{season}} · {{count, number}} episodes added",
	/** Card subline — episodes recently added to a show (singular) */
	videosCardNewEpisodes_one: "{{count, number}} episode added",
	/** Card subline — episodes recently added to a show (plural) */
	videosCardNewEpisodes_other: "{{count, number}} episodes added",
	/** Card subline — a format the browser can't play; {{container}} = e.g. AVI */
	videosCardUnsupported: "{{container}} · Download to watch",
	/** Card badge — a format the browser can't play */
	videosCardNotPlayable: "Not playable",
	/** Card accessible name — part saying how much was watched */
	videosCardPercentWatched: "{{fraction, number(style: percent)}} watched",
	/** Card accessible name — its parts (title, year or episode, progress, badges) joined; {{parts}} = the list */
	videosCardLabel: "{{parts, list(type: unit)}}",
	/** Card accessible name — unwatched episodes of a show (singular) */
	videosCardUnwatchedCount_one: "{{count, number}} unwatched episode",
	/** Card accessible name — unwatched episodes of a show (plural) */
	videosCardUnwatchedCount_other: "{{count, number}} unwatched episodes",
	/** Card accessible name — the title was watched */
	videosCardWatched: "watched",
	/** Card accessible name — the format can't be played here */
	videosCardNotPlayableLabel: "not playable here",
	/** Card hover button — accessible name; {{title}} = the card's title */
	videosCardPlayLabel: "Play {{title}}",
	/** Card menu trigger — accessible name */
	videosCardMenu: "More options for {{title}}",
	/** Card menu — plays the title */
	videosCardPlay: "Play",
	/** Card menu — continues where playback stopped */
	videosCardResume: "Resume",
	/** Card menu — marks every video of the card watched */
	videosCardMarkWatched: "Mark as watched",
	/** Card menu — marks every video of the card unwatched */
	videosCardMarkUnwatched: "Mark as unwatched",
	/** Card menu — removes a started video from Continue Watching until it is played again */
	videosCardHide: "Remove from Continue Watching",
	/** Toast — saving a watch-state change failed */
	videosCardWatchStateFailed: "Couldn't save the change",

	// ── Library grids ──────────────────────────────────────────────────────────
	/** Grid search — placeholder and accessible name in Movies */
	videosGridSearchMovies: "Search movies",
	/** Grid search — placeholder and accessible name in Shows */
	videosGridSearchShows: "Search shows",
	/** Grid search — placeholder and accessible name in Other and in one library directory */
	videosGridSearchTitles: "Search titles",
	/** Grid toolbar — accessible name of the sort select */
	videosGridSortLabel: "Sort",
	/** Sort — by title */
	videosGridSortTitle: "Title A–Z",
	/** Sort — newest added first */
	videosGridSortAdded: "Date added",
	/** Sort — newest year first */
	videosGridSortYear: "Year",
	/** Sort — longest first; needs the files read */
	videosGridSortRuntime: "Runtime",
	/** Sort — most recently played first */
	videosGridSortPlayed: "Last played",
	/** Sort — shuffled once per session */
	videosGridSortRandom: "Random",
	/** Grid toolbar — accessible name of the watch-state chips */
	videosGridFilterLabel: "Filter by watch state",
	/** Watch-state chip — every title */
	videosGridFilterAll: "All",
	/** Watch-state chip — nothing played yet */
	videosGridFilterUnwatched: "Unwatched",
	/** Watch-state chip — started, not finished */
	videosGridFilterInProgress: "In progress",
	/** Watch-state chip — finished */
	videosGridFilterWatched: "Watched",
	/** Grid toolbar — accessible name of the resolution select */
	videosGridQualityLabel: "Resolution",
	/** Resolution select — no filter */
	videosGridQualityAll: "Any resolution",
	/** Resolution select — 2160p */
	videosGridQuality2160: "4K",
	/** Resolution select — 1080p */
	videosGridQuality1080: "1080p",
	/** Resolution select — 720p */
	videosGridQuality720: "720p",
	/** Resolution select — below 720p */
	videosGridQualitySd: "SD",
	/** Grid toolbar — accessible name of the library directory select */
	videosGridRootLabel: "Library directory",
	/** Library directory select — no filter */
	videosGridRootAll: "All directories",
	/** Grid toolbar — title count (singular) */
	videosGridCount_one: "{{count, number}} title",
	/** Grid toolbar — title count (plural) */
	videosGridCount_other: "{{count, number}} titles",
	/** Grid coverage hint — runtime sort while not every file has been read */
	videosGridCoverageRuntime: "Runtime: {{known, number}} of {{total, number}} known. Unknown sorts last.",
	/** Grid coverage hint — resolution filter while not every resolution is known */
	videosGridCoverageQuality: "Resolution: {{known, number}} of {{total, number}} known. Unknown is left out.",
	/** Grid — accessible name of the card list; {{name}} = the view's name */
	videosGridLabel: "{{name}}",
	/** Grid — no title matches the search and filters */
	videosGridNoMatchesTitle: "No matching titles",
	/** Grid — no title matches, body */
	videosGridNoMatchesBody: "Try another search, or clear the filters.",
	/** Grid — clears search and filters */
	videosGridClearFilters: "Clear filters",
	/** Grid — the view has no titles at all */
	videosGridEmptyTitle: "Nothing here yet",
	/** Grid — the view has no titles at all, body */
	videosGridEmptyBody: "Titles show up here once a library directory holds some.",
	/** Grid toolbar on phones — opens the sort and filter controls */
	videosGridFilters: "Filters",
	/** Header — smaller cards */
	videosGridDensityDecrease: "Smaller cards",
	/** Header — larger cards */
	videosGridDensityIncrease: "Larger cards",

	// ── Search ─────────────────────────────────────────────────────────────────
	/** Search — input placeholder and accessible name */
	videosSearchPlaceholder: "Search titles and episodes",
	/** Search — results group of episodes */
	videosSearchEpisodes: "Episodes",
	/** Search — a group shows only part of its results; {{shown}} and {{total}} = counts */
	videosSearchShownOf: "Showing {{shown, number}} of {{total, number}}",
	/** Search — result count announced (singular) */
	videosSearchResults_one: "{{count, number}} result",
	/** Search — result count announced (plural) */
	videosSearchResults_other: "{{count, number}} results",
	/** Search — nothing matches; {{query}} = what was typed */
	videosSearchNoResultsTitle: "No results for “{{query}}”",
	/** Search — nothing matches, body */
	videosSearchNoResultsBody: "Search looks at titles, years, directory names and episode titles.",
	/** Search — before anything is typed */
	videosSearchEmptyTitle: "Search your library",
	/** Search — before anything is typed, body */
	videosSearchEmptyBody: "Find movies, shows, episodes and other videos by name, year or directory.",
	/** Shortcut description — focuses a library view's search box */
	videosSearchCommand: "Search the library view",
	/** Shortcut description — opens Videos search */
	videosOpenSearchCommand: "Open Videos search",

	// ── Player ─────────────────────────────────────────────────────────────────
	/** Player — the page title while the player is open */
	playerPageTitle: "Player",
	/** Player — accessible name of the stage region and the picture; {{title}} = what plays */
	playerRegion: "Player: {{title}}",
	/** Player top bar — leaves the player */
	playerBack: "Back",
	/** Player top bar title for an episode; {{series}} name, {{code}} like S1:E3, {{title}} episode title */
	playerTitleEpisode: "{{series}} · {{code}} · {{title}}",
	/** Player top bar title for an episode without a title of its own */
	playerTitleEpisodeShort: "{{series}} · {{code}}",
	/** Player top bar title for a movie version other than the main one; {{version}} = its label */
	playerTitleVersion: "{{title}} · {{version}}",
	/** Player — the bottom bar's group label */
	playerControls: "Video controls",
	/** Player — play button */
	playerPlay: "Play",
	/** Player — pause button */
	playerPause: "Pause",
	/** Player — 10 seconds back */
	playerSeekBack: "Back 10 seconds",
	/** Player — 10 seconds forward */
	playerSeekForward: "Forward 10 seconds",
	/** Player — double-tap ripple, left third */
	playerSeekBackShort: "−10 s",
	/** Player — double-tap ripple, right third */
	playerSeekForwardShort: "+10 s",
	/** Player — the seek slider's accessible name */
	playerSeek: "Seek",
	/** Player — time readout button, currently showing the remaining time */
	playerShowTotal: "Show total length",
	/** Player — time readout button, currently showing the total length */
	playerShowRemaining: "Show remaining time",
	/** Player — a stacked item's part chip; {{part}} of {{count}} */
	playerPart: "Part {{part, number}} of {{count, number}}",
	/** Player — previous episode button */
	playerPrevious: "Previous episode",
	/** Player — next episode button */
	playerNext: "Next episode",
	/** Player — episodes panel button and panel title */
	playerEpisodes: "Episodes",
	/** Episodes panel — a season tab; {{number}} = season number */
	playerSeason: "Season {{number}}",
	/** Episodes panel — the specials tab */
	playerSpecials: "Specials",
	/** Episodes panel — row badge on the episode playing now */
	playerEpisodeNow: "Playing",
	/** Episodes panel — screen-reader text on an episode already watched */
	playerEpisodeWatched: "Watched",
	/** Player — picture-in-picture button */
	playerPictureInPicture: "Picture in picture",
	/** Player — picture-in-picture button while active */
	playerExitPictureInPicture: "Exit picture in picture",
	/** Player — fullscreen button */
	playerFullscreen: "Fullscreen",
	/** Player — fullscreen button while fullscreen */
	playerExitFullscreen: "Exit fullscreen",
	/** Player — settings (gear) button */
	playerSettings: "Settings",
	/** Settings menu — playback speed group */
	playerSpeed: "Speed",
	/** Settings menu — 1× speed */
	playerSpeedNormal: "Normal",
	/** Settings menu — any other speed; {{rate}} = the multiplier */
	playerSpeedRate: "{{rate}}×",
	/** Settings menu — mute toggle on a phone, where the bar has no volume */
	playerMute: "Mute",
	/** Settings menu — unmute toggle on a phone */
	playerUnmute: "Unmute",
	/** Settings menu — explains why there is no cast button */
	playerCast: "Cast to a TV",
	/** Cast panel — body */
	playerCastUnavailable:
		"Casting isn't available for your private library. Files are decrypted only on this device. Use screen mirroring, HDMI or a browser on the TV.",
	/** Player — keyboard shortcuts button and sheet */
	playerShortcuts: "Keyboard shortcuts",
	/** Shortcuts sheet — title */
	playerShortcutsTitle: "Keyboard shortcuts",
	/** Shortcuts sheet rows */
	playerKeyPlayPause: "Play or pause",
	playerKeyBack: "Back 10 seconds",
	playerKeyForward: "Forward 10 seconds",
	playerKeyVolume: "Volume up or down",
	playerKeyMute: "Mute",
	playerKeyFullscreen: "Fullscreen",
	playerKeySubtitles: "Subtitles on or off",
	playerKeySubtitleDelay: "Subtitles earlier or later",
	playerKeySkip: "Skip intro or credits",
	playerKeyNextPrevious: "Next or previous episode",
	playerKeyPercent: "Jump to 0–90%",
	playerKeyStartEnd: "Start or end",
	playerKeyChapters: "Previous or next chapter",
	playerKeyFrame: "Frame back or forward (paused)",
	playerKeySpeed: "Slower or faster",
	playerKeyPictureInPicture: "Picture in picture",
	playerKeyShortcuts: "These shortcuts",
	/** Player — a stall longer than 15 seconds */
	playerStillLoading: "Still loading…",
	/** Player — retries after a long stall or a failure */
	playerRetry: "Try again",
	/** Player — a direct stream is being re-established */
	playerReconnecting: "Reconnecting…",
	/** Player — the connection is gone */
	playerOffline: "You're offline. Playback will resume when you're back online.",
	/** Player — resume pill; {{time}} = position */
	playerResumedAt: "Resumed at {{time}}",
	/** Player — resume pill action */
	playerStartOver: "Start over",
	/** Player — the item can't be found in the library any more */
	playerMissingTitle: "This video isn't in your library any more",
	/** Player — the file's headers couldn't be read */
	playerProbeFailedTitle: "This video couldn't be opened",
	/** Player — the file's headers couldn't be read, body */
	playerProbeFailedBody: "Its file couldn't be read. Check your connection and try again.",
	/** Player — no way to play this file in this browser */
	playerUnsupportedTitle: "This video can't be played here",
	/** Player — no way to play this file in this browser, body */
	playerUnsupportedBody: "Its format isn't supported here. You can download it from Cloud Drive and play it in another app.",
	/** Player — playback failed */
	playerFailedTitle: "Playback stopped",
	/** Player — playback failed, body */
	playerFailedBody: "Something went wrong while playing this video.",
	/** Player — Firefox can't start this HEVC video at the chosen point */
	playerFailedOpenGop: "This browser can only start this video from its beginning.",
	/** Player — keyframes too far apart to stream */
	playerFailedKeyframes: "This video's keyframes are too far apart to stream.",
	/** Player — tracks popover (CC button) and its accessible name */
	playerTracks: "Audio and subtitles",
	/** Tracks popover — audio column */
	playerAudio: "Audio",
	/** Tracks popover — subtitles column */
	playerSubtitles: "Subtitles",
	/** Tracks popover — an audio track without a known language; {{number}} = its position */
	playerTrackNumber: "Track {{number}}",
	/** Tracks popover — mono audio */
	playerChannelsMono: "Mono",
	/** Tracks popover — stereo audio */
	playerChannelsStereo: "Stereo",
	/** Tracks popover — a commentary track */
	playerAudioCommentary: "Commentary",
	/** Tracks popover — tooltip on an audio track this browser can't play as it is */
	playerAudioTranscoded: "Converted to stereo for playback",
	/** Tracks popover — the file has no audio */
	playerAudioNone: "No audio",

	// ── Subtitles ──────────────────────────────────────────────────────────────
	/** Tracks popover — automatic subtitle choice */
	subtitleAuto: "Auto (Smart)",
	/** Tracks popover — what Auto picked; {{track}} = its name */
	subtitleAutoShowing: "Showing {{track}}",
	/** Tracks popover — Auto picked nothing */
	subtitleAutoNone: "None needed",
	/** Tracks popover — subtitles off */
	subtitleOff: "Off",
	/** Tracks popover — a subtitle track without a known language */
	subtitleUnknownLanguage: "Unknown language",
	/** Tracks popover — forced subtitles (foreign parts only) */
	subtitleForced: "Forced",
	/** Tracks popover — subtitles for the deaf and hard of hearing */
	subtitleSdh: "SDH",
	/** Tracks popover — a subtitle track inside the file, which can't be shown yet */
	subtitleEmbeddedUnavailable: "In the file · not supported yet",
	/** Tracks popover — an image subtitle format */
	subtitleImageUnavailable: "Image subtitles aren't supported",
	/** Tracks popover footer — opens the subtitle style panel */
	subtitleStyleOpen: "Style…",
	/** Tracks popover footer — opens the subtitle delay panel */
	subtitleDelayOpen: "Delay…",
	/** Tracks popover footer — the subtitle file's text encoding */
	subtitleEncoding: "Encoding",
	/** Encoding picker — automatic detection; {{encoding}} = what was detected */
	subtitleEncodingAuto: "Automatic ({{encoding}})",
	/** Player notice — the chosen subtitles are being read */
	subtitleLoading: "Loading subtitles…",
	/** Player notice — the subtitle file is over the size limit */
	subtitleTooLarge: "This subtitle file is too large to show.",
	/** Player notice — the subtitle file has no readable cues */
	subtitleUnreadable: "This subtitle file can't be read.",
	/** Player notice — the subtitle file couldn't be downloaded */
	subtitleUnavailable: "Subtitles couldn't be loaded.",
	/** Subtitle style panel — title */
	subtitleStyleTitle: "Subtitle style",
	/** Subtitle style panel — sample line shown while the panel is open */
	subtitleStyleSample: "Subtitles look like this",
	/** Subtitle style panel rows */
	subtitleSize: "Size",
	subtitleFont: "Font",
	subtitleColor: "Colour",
	subtitleBackground: "Background",
	subtitleEdge: "Edge",
	subtitlePosition: "Position",
	subtitleSizeSmallest: "XS",
	subtitleSizeSmall: "S",
	subtitleSizeNormal: "M",
	subtitleSizeLarge: "L",
	subtitleSizeLarger: "XL",
	subtitleSizeLargest: "XXL",
	subtitleFontSans: "Sans",
	subtitleFontSerif: "Serif",
	subtitleFontMono: "Mono",
	subtitleColorWhite: "White",
	subtitleColorYellow: "Yellow",
	subtitleColorCyan: "Cyan",
	subtitleColorGreen: "Green",
	subtitleColorMagenta: "Magenta",
	subtitleBackgroundNone: "None",
	subtitleBackgroundTranslucent: "Translucent",
	subtitleBackgroundSolid: "Solid",
	subtitleEdgeNone: "None",
	subtitleEdgeShadow: "Shadow",
	subtitleEdgeOutline: "Outline",
	subtitleEdgeRaised: "Raised",
	subtitleEdgeDepressed: "Depressed",
	subtitlePositionLowest: "Lowest",
	subtitlePositionLow: "Low",
	subtitlePositionMiddle: "Middle",
	subtitlePositionHigh: "High",
	subtitlePositionHighest: "Highest",
	/** Subtitle style panel — back to the defaults */
	subtitleStyleReset: "Reset",
	/** Subtitle delay panel — title */
	subtitleDelayTitle: "Subtitle delay",
	/** Subtitle delay panel — show subtitles earlier */
	subtitleDelayEarlier: "Earlier",
	/** Subtitle delay panel — show subtitles later */
	subtitleDelayLater: "Later",
	/** Subtitle delay panel — hint */
	subtitleDelayHint: "Saved for this video. G and H adjust it while playing.",
	/** Subtitle delay panel — back to no delay */
	subtitleDelayReset: "Reset",
	/** Player notice after G or H; {{delay}} like "+0.3 s" */
	subtitleDelayNotice: "Subtitle delay {{delay}}",

	// ── Skip and Up Next ───────────────────────────────────────────────────────
	/** Skip button over the picture, per segment kind */
	skipIntro: "Skip intro",
	skipCredits: "Skip credits",
	skipRecap: "Skip recap",
	skipPreview: "Skip preview",
	skipCommercial: "Skip ad",
	skipIntermission: "Skip intermission",
	/** Up Next card — eyebrow */
	upNextLabel: "Up next",
	/** Up Next card — screen-reader announcement; {{title}} = next item */
	upNextAnnounce: "Up next: {{title}}",
	/** Up Next card — plays the next item now */
	upNextPlayNow: "Play now",
	/** Up Next card — dismisses the card for this item */
	upNextWatchCredits: "Watch credits",
	/** Up Next card — runtime; {{minutes}} */
	upNextMinutes: "{{minutes}} min",
	/** Still watching card — title; {{title}} = series or movie */
	upNextStillWatching: "Are you still watching {{title}}?",
	/** Still watching card — goes on */
	upNextContinue: "Continue watching",
	/** Autoplay blocked card — title; {{title}} = next item */
	upNextBlocked: "Play next: {{title}}",
	/** Autoplay blocked card and post-play — starts playback */
	upNextPlay: "Play",
	/** Post-play — title; {{title}} = what just ended */
	upNextFinished: "Finished {{title}}",
	/** Post-play — plays the same item again */
	upNextPlayAgain: "Play again",
	/** Post-play — plays the next unwatched item; {{title}} */
	upNextNextTitle: "Next: {{title}}",

	// ── Title pages (movie, other video, series) ───────────────────────────────
	/** Browser tab title of a title's page */
	detailPageTitle: "Details",
	/** Title page — back to where it was opened from */
	detailBack: "Back",
	/** Home hero — opens the title's page */
	detailMoreInfo: "More info",
	/** Title page — eyebrow above a movie's title */
	detailEyebrowMovie: "Movie",
	/** Title page — eyebrow above another video's title */
	detailEyebrowOther: "Video",
	/** Title page — eyebrow above a series' title */
	detailEyebrowSeries: "Series",
	/** Title page — accessible label of the More menu trigger; {{title}} */
	detailMenu: "More options for {{title}}",
	/** More menu — submenu choosing the version to play */
	detailVersions: "Versions",
	/** More menu — opens the file's directory in Cloud Drive */
	detailRevealInDrive: "Show in Cloud Drive",
	/** More menu — downloads the file */
	detailDownload: "Download",
	/** More menu — opens the corrections dialog */
	detailEdit: "Edit details…",
	/** More menu — hides the title from Videos */
	detailHide: "Hide from Videos",
	/** More menu — shows a hidden title again */
	detailUnhide: "Show in Videos again",
	/** Toast — the file is no longer in the library */
	detailFileGone: "This file is no longer in the library.",
	/** Title page — what is left of the resume point; {{time}} = e.g. 1h 31m */
	detailTimeLeft: "{{time}} left",
	/** Title page — label of the version select */
	detailVersion: "Version",
	/** Version select — a version without a name; {{number}} */
	detailVersionNumber: "Version {{number}}",
	/** Version badge — plays as the file is */
	detailBadgeDirect: "Direct",
	/** Version badge — repackaged for this browser while it plays */
	detailBadgeRemux: "Remux",
	/** Version badge — this browser can't play it */
	detailBadgeUnsupported: "Not playable",
	/** Synopsis — expands the clamped text */
	detailMore: "More",
	/** Synopsis — collapses it again */
	detailLess: "Less",
	/** Title page — cast names from the .nfo; {{names}} */
	detailCast: "Cast: {{names}}",
	/** Title page — heading of the extras shelf */
	detailExtras: "Extras",
	/** Extra type */
	detailExtraTrailer: "Trailer",
	/** Extra type */
	detailExtraFeaturette: "Featurette",
	/** Extra type */
	detailExtraBehindTheScenes: "Behind the scenes",
	/** Extra type */
	detailExtraDeletedScene: "Deleted scene",
	/** Extra type */
	detailExtraInterview: "Interview",
	/** Extra type */
	detailExtraScene: "Scene",
	/** Extra type */
	detailExtraShort: "Short",
	/** Extra type */
	detailExtraClip: "Clip",
	/** Extra type */
	detailExtraUnknown: "Extra",
	/** Extras shelf — accessible name of a card; {{type}}, {{title}} */
	detailExtraLabel: "{{type}}: {{title}}",
	/** Series page — the smart button resuming an episode; {{code}} = S2E5, {{left}} = e.g. 21 min left */
	detailResumeEpisode: "Resume {{code}} · {{left}}",
	/** Series page — the smart button playing the next episode; {{code}} = S2E6 */
	detailPlayEpisode: "Play {{code}}",
	/** Series page metadata — number of seasons (singular) */
	detailSeasonCount_one: "{{count, number}} season",
	/** Series page metadata — number of seasons (plural) */
	detailSeasonCount_other: "{{count, number}} seasons",
	/** Series page metadata — number of episodes (singular) */
	detailEpisodeCount_one: "{{count, number}} episode",
	/** Series page metadata — number of episodes (plural) */
	detailEpisodeCount_other: "{{count, number}} episodes",
	/** Series page metadata — unwatched episodes */
	detailUnwatchedCount_one: "{{count, number}} unwatched",
	/** Series page metadata — unwatched episodes */
	detailUnwatchedCount_other: "{{count, number}} unwatched",
	/** Series page — accessible name of the season tabs or select */
	detailSeasons: "Seasons",
	/** Season select — a season whose episodes are all watched; {{number}} */
	detailSeasonWatched: "Season {{number}} · watched",
	/** Season select — unwatched episodes in a season (singular) */
	detailSeasonUnwatched_one: "Season {{number}} · {{count, number}} unwatched",
	/** Season select — unwatched episodes in a season (plural) */
	detailSeasonUnwatched_other: "Season {{number}} · {{count, number}} unwatched",
	/** Series page — accessible label of the season menu; {{number}} */
	detailSeasonMenu: "More options for season {{number}}",
	/** Season menu */
	detailMarkSeasonWatched: "Mark season watched",
	/** Season menu */
	detailMarkSeasonUnwatched: "Mark season unwatched",
	/** Series page — marks every episode watched */
	detailMarkSeriesWatched: "Mark series watched",
	/** Series page — marks every episode unwatched */
	detailMarkSeriesUnwatched: "Mark series unwatched",
	/** Series page — collapsed specials (season 0) (singular) */
	detailSpecials_one: "Specials ({{count, number}})",
	/** Series page — collapsed specials (season 0) (plural) */
	detailSpecials_other: "Specials ({{count, number}})",
	/** Episode row — accessible label of its menu; {{title}} */
	detailEpisodeMenu: "More options for {{title}}",
	/** Episode menu — opens the corrections dialog for the episode */
	detailEditEpisode: "Edit episode…",
	/** Title page — the title isn't in the library */
	detailNotFound: "Not in your library",
	/** Title page — why it may be missing */
	detailNotFoundDescription: "It may have been moved, deleted or hidden, or its library directory removed.",

	// ── Corrections dialog ─────────────────────────────────────────────────────
	/** Corrections dialog — title for a movie, video or series */
	detailEditTitle: "Edit details",
	/** Corrections dialog — title for an episode */
	detailEditEpisodeTitle: "Edit episode",
	/** Corrections dialog — description */
	detailEditDescription: "Corrections are saved with your library and win over what the file names say.",
	/** Corrections field */
	detailFieldTitle: "Title",
	/** Corrections field */
	detailFieldYear: "Year",
	/** Corrections field — error */
	detailFieldYearInvalid: "Enter a year between 1800 and 2200, or leave it empty.",
	/** Corrections field — what the item is shown as */
	detailFieldKind: "Show as",
	/** Show as option */
	detailKindMovie: "Movie",
	/** Show as option */
	detailKindEpisode: "Episode",
	/** Show as option */
	detailKindOther: "Other video",
	/** Corrections field — the series an episode belongs to */
	detailFieldSeries: "Series",
	/** Series option — a new series named after the item; {{title}} */
	detailNewSeries: "New series: {{title}}",
	/** Corrections field */
	detailFieldSeason: "Season",
	/** Corrections field */
	detailFieldEpisode: "Episode",
	/** Corrections field — error */
	detailFieldEpisodeRequired: "An episode needs its season and episode number.",
	/** Corrections field — hides the title from home, grids and search */
	detailFieldHidden: "Hide from Videos",
	/** Corrections — merge a series into another */
	detailMergeInto: "Merge into another series",
	/** Merge select — nothing chosen yet */
	detailMergeChoose: "Choose a series",
	/** Corrections — merges */
	detailMerge: "Merge",
	/** Corrections — what Split does */
	detailSplitDescription: "Shows the series merged into this one, or found in other library directories, on their own again.",
	/** Corrections — splits */
	detailSplit: "Split",
	/** Corrections — removes every correction of the item */
	detailReset: "Reset corrections",
	/** Corrections — saves */
	detailSave: "Save",
	/** Libraries dialog — hidden titles, with a way to show them again */
	detailHiddenTitles: "Hidden titles",
	/** Corrections field — last episode a multi-episode file holds; optional */
	detailFieldEpisodeEnd: "Last episode (optional, for a multi-episode file)"
} as const
