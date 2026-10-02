// A dialog whose body is one long list (a picker, participants, versions): wide and near the viewport's
// height so the list gets the room instead of scrolling in a small box, and a fixed height rather than
// content-sized so the footer never moves while browsing.
export const LIST_DIALOG_CLASS = "flex h-[min(48rem,calc(100dvh-2rem))] flex-col sm:max-w-3xl"

// The list (or its loading/empty state) inside a LIST_DIALOG_CLASS dialog: takes the room the header and
// footer leave.
export const LIST_DIALOG_BODY_CLASS = "min-h-0 flex-1"
