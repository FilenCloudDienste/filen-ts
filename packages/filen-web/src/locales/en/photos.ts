// English source catalog — "photos" namespace: the /photos screen (features/photos/screens/photos.tsx),
// its Directories dialog (features/photos/components/directoriesDialog.tsx) and its directory chooser
// (features/photos/components/directoryChooserDialog.tsx). Same typed-
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
	/** Unset-state hero — button opening the directory chooser dialog */
	photosChooseDirectory: "Choose directory",

	// ── Ready state screen header ──────────────────────────────────────────────
	/** Screen header, after "Photos ·", with several photos directories (one shows its own name instead) — singular */
	photosHeaderDirectories_one: "{{count, number}} directory",
	/** Screen header, after "Photos ·", with several photos directories (one shows its own name instead) — plural */
	photosHeaderDirectories_other: "{{count, number}} directories",
	/** Screen header — button opening the Directories dialog (the photos directories, add and remove) */
	photosDirectoriesButton: "Directories",
	/** Empty state — the photos directories (and every subdirectory under them) have no photos or videos */
	photosEmptyTitle: "No photos yet",
	/** Empty state — body explaining what would show up here, with one photos directory */
	photosEmptyBody_one: "Images and videos anywhere inside this directory, including its subdirectories, show up here.",
	/** Empty state — body explaining what would show up here, with several photos directories */
	photosEmptyBody_other: "Images and videos anywhere inside these directories, including their subdirectories, show up here.",

	// ── Root-gone handling ──────────────────────────────────────────────────────
	/** Toast shown when a photos directory no longer exists (deleted/trashed elsewhere) and was removed from Photos; with no directory left the screen falls back to the unset hero */
	photosRootGoneToast: "A photos directory is no longer available and was removed from Photos.",

	// ── Directories dialog ───────────────────────────────────────────────────────
	/** Directories dialog and chooser — the synced photos directories were saved by a newer version of Filen, so this one only shows them */
	photosLibraryReadOnly: "Saved by a newer version of Filen. Update the app to change your photo directories.",
	/** Directories dialog — title */
	photosDirectoriesTitle: "Photo directories",
	/** Directories dialog — description under the title */
	photosDirectoriesDescription:
		"Photos shows the images and videos inside these directories, including their subdirectories, on one timeline.",
	/** Directories dialog — shown instead of the list once every directory was removed */
	photosDirectoriesNone: "No directory is part of Photos yet.",
	/** Directories dialog — a directory another photos directory holds (both devices added one at once, or it was moved there): its path, and the directory it is read through */
	photosDirectoryWithin: "{{path}} · included in {{name}}",
	/** Directories dialog — accessible label of a directory's remove (✕) button */
	photosRemoveDirectory: "Remove {{name}} from Photos",
	/** Directories dialog — footer button opening the directory chooser */
	photosAddDirectory: "Add directory",
	/** Directories dialog — footer button closing the dialog */
	photosDirectoriesDone: "Done",
	/** Remove confirmation — title */
	photosRemoveConfirmTitle: "Remove {{name}}?",
	/** Remove confirmation — body; nothing in the drive changes */
	photosRemoveConfirmBody: "Removes {{name}} from Photos only. Its files stay where they are.",
	/** Remove confirmation — confirm button */
	photosRemoveConfirmAction: "Remove",

	// ── Chooser dialog ───────────────────────────────────────────────────────────
	/** Chooser dialog — title, while Photos has no directory yet */
	photosChooserTitle: "Choose a photos directory",
	/** Chooser dialog — title, adding a directory next to the existing ones */
	photosChooserAddTitle: "Add a directory to Photos",
	/** Chooser dialog — local search input placeholder + accessible label */
	photosChooserFilterPlaceholder: "Filter directories",
	/** Chooser dialog — confirm button, enabled once a directory has been opened (browsing the root listing itself does not count as a choice) */
	photosChooserConfirmAction: "Choose this directory",
	/** Chooser dialog — row hint and footer note: the directory already is a photos directory */
	photosChooserAlreadyRoot: "Already in Photos",
	/** Chooser dialog — footer note: the open directory sits inside a photos directory, so its photos already show (it can't be added) */
	photosChooserInsideRoot: "Inside {{name}}, already in Photos",
	/** Chooser dialog — warning: the picked directory holds photos directories, which adding it replaces */
	photosChooserReplaceBody: "Photo directories can't overlap. Adding {{name}} replaces {{names}}.",
	/** Chooser dialog — confirms the replacement */
	photosChooserReplaceAction: "Replace",
	/** Chooser dialog — warning: the picked directory is Filen's own */
	photosChooserSystemDirectory: "This directory belongs to Filen and can't be added.",
	/** Chooser dialog — warning: the picked directory can't be resolved any more */
	photosChooserNotFound: "This directory can't be found any more.",
	/** Chooser dialog — leaves a warning, back to browsing */
	photosChooserBack: "Back",

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
