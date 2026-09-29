import { type ItemActionId } from "@/features/drive/components/itemMenu.logic"

// Photos items are always owned, decryptable files, so drive's own item menu applies as is (tile and
// preview alike) minus Move: mobile hides it from its photos context too, and a flat cross-tree
// projection has no directory context for a move destination to restart from. Copy stays: its
// destination is picked in the Cloud Drive tree, whatever surface it starts from.
export const PHOTOS_HIDDEN_ACTION_IDS: ReadonlySet<ItemActionId> = new Set(["move"])
