import { type ItemActionId } from "@/features/drive/components/itemMenu.logic"
import { type BulkActionDescriptor } from "@/features/drive/components/bulkActionBar.logic"

// Photos items are always owned, decryptable files, so drive's own item menu applies as is (tile and
// preview alike) minus Move: mobile hides it from its photos context too, and a flat cross-tree
// projection has no directory context for a move destination to restart from. Copy stays: its
// destination is picked in the Cloud Drive tree, whatever surface it starts from. Compress and Extract
// wait for their photos wiring (the dialog host doesn't route them yet).
export const PHOTOS_HIDDEN_ACTION_IDS: ReadonlySet<ItemActionId> = new Set(["move", "compress", "extract"])

// The selection bar's counterpart (bulkActionBar.tsx), for the same reasons.
export const PHOTOS_HIDDEN_BULK_ACTION_IDS: ReadonlySet<BulkActionDescriptor["id"]> = new Set(["move", "compress", "extract"])
