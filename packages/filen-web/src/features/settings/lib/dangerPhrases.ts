// The typed-confirmation phrases for the two bulk-delete cards, kept in one small pure module
// (rather than inline in each card) so a test can assert they're non-empty and mutually distinct —
// a copy-paste collision here would let one card's typed phrase accidentally arm the other's dialog if
// they were ever composed together. Same TypedConfirmDialog primitive drive's emptyTrashButton already
// uses for an equally severe whole-drive-scale destructive op (see driveEmptyTrashTypedConfirmPhrase).
export const DELETE_ALL_VERSIONS_PHRASE = "DELETE VERSIONS"
export const DELETE_ALL_ITEMS_PHRASE = "DELETE EVERYTHING"
