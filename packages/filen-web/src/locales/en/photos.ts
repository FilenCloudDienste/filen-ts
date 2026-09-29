// English source catalog — "photos" namespace: the /photos screen (features/photos/screens/photos.tsx)
// and its root-directory chooser (features/photos/components/directoryChooserDialog.tsx). Same typed-
// catalog rules as common/drive/transfers: flat `as const` object, camelCase keys, no literal '.' or
// ':' (real i18next namespaces, keySeparator/nsSeparator both ON). Shared breadcrumb/filter/"move here"-
// shaped copy the chooser reuses verbatim lives in the "drive" namespace (driveMyDrive,
// driveBreadcrumbLabel) rather than being duplicated here.
export const photos = {
	// ── Unset hero (no root chosen yet) ───────────────────────────────────────
	/** Unset-state hero — title shown before any photos root directory has been chosen */
	photosUnsetTitle: "Choose your photos directory",
	/** Unset-state hero — body explaining what the chosen directory becomes */
	photosUnsetBody: "Photos shows the images and videos inside a directory you choose, including anything in its subdirectories.",
	/** Unset-state hero + screen header (once ready) — button opening the directory chooser dialog */
	photosChooseDirectory: "Choose directory",

	// ── Ready state screen header ──────────────────────────────────────────────
	/** Screen header — affordance re-opening the chooser to pick a different root directory */
	photosChangeDirectory: "Change directory",
	/** Empty state — the chosen directory (and every subdirectory under it) has no photos or videos */
	photosEmptyTitle: "No photos yet",
	/** Empty state — body explaining what would show up here */
	photosEmptyBody: "Images and videos anywhere inside this directory, including its subdirectories, show up here.",

	// ── Root-gone handling ──────────────────────────────────────────────────────
	/** Toast shown when the saved photos root directory no longer exists (deleted/trashed elsewhere); the screen falls back to the unset hero right after */
	photosRootGoneToast: "Your photos directory is no longer available.",

	// ── Chooser dialog ───────────────────────────────────────────────────────────
	/** Chooser dialog — title */
	photosChooserTitle: "Choose a photos directory",
	/** Chooser dialog — local search input placeholder + accessible label */
	photosChooserFilterPlaceholder: "Filter directories",
	/** Chooser dialog — confirm button, enabled once a directory has been opened (browsing the root listing itself does not count as a choice) */
	photosChooserConfirmAction: "Choose this directory",

	// ── Media grid ───────────────────────────────────────────────────────────────
	/** Accessible label for the virtualized grid's own listbox role */
	photosGridLabel: "Photos grid",
	/** Density stepper — shrinks tiles (more columns fit); disabled at the smallest step */
	photosDensityDecrease: "Smaller tiles",
	/** Density stepper — grows tiles (fewer columns fit); disabled at the largest step */
	photosDensityIncrease: "Larger tiles",

	// ── Search and filters ─────────────────────────────────────────────────────────
	/** Search box placeholder + accessible label; matches file names, directory names and capture dates */
	photosSearch: "Search photos",
	/** Accessible label of the filter chip group */
	photosFilterLabel: "Filter photos",
	/** Filter chip — every kind of media */
	photosFilterAll: "All",
	/** Filter chip — still images only (not RAW, not video) */
	photosFilterImages: "Photos",
	/** Filter chip — videos only */
	photosFilterVideos: "Videos",
	/** Filter chip — camera RAW files only */
	photosFilterRaw: "RAW",
	/** Filter chip — favorited items only; combines with the kind chips */
	photosFilterFavorites: "Favorites",
	/** How many items match the search and filters (singular) */
	photosResultCount_one: "{{count}} result",
	/** How many items match the search and filters (plural) */
	photosResultCount_other: "{{count}} results",
	/** Empty state — nothing matches the search and filters */
	photosNoMatchesTitle: "No matching photos",
	/** Empty state body — what the search looks at */
	photosNoMatchesBody: "Search looks at file names, directory names and dates like 2023, July or July 2023.",
	/** Empty state action — clears the search text and every filter chip */
	photosClearFilters: "Clear search and filters"
} as const
