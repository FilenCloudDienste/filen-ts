// English source catalog — "photos" namespace: the /photos screen (features/photos/screens/photos.tsx)
// and its root-directory chooser (features/photos/components/directoryChooserDialog.tsx). Same typed-
// catalog rules as common/drive/transfers: flat `as const` object, camelCase keys, no literal '.' or
// ':' (real i18next namespaces, keySeparator/nsSeparator both ON). Shared breadcrumb/filter/"move here"-
// shaped copy the chooser reuses verbatim lives in the "drive" namespace (driveMyDrive,
// driveBreadcrumbLabel, driveSearchNoResults) rather than being duplicated here.
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
	photosDensityIncrease: "Larger tiles"
} as const
