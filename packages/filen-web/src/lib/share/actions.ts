import type { Contact } from "@filen/sdk-rs"
import { sdkApi } from "@/lib/sdk/client"
import { queryClient } from "@/queries/client"
import { driveListingQueryKey } from "@/queries/drive"
import { asDirectoryOrFile, type DriveItem } from "@/lib/drive/item"
import { runOp } from "@/lib/actions/outcome"
import { runBulk, type BulkOutcome } from "@/lib/drive/bulk"

// Shares each item with every chosen contact — the outward-facing write of the sharing domain,
// zero-`useMutation` (typed async helper + a cache invalidate on success), LABEL-FIRST error shaping
// via runOp/asErrorDTO like every other action helper.
//
// Granularity is per-ITEM (BulkOutcome<DriveItem>, so the picker toasts through the shared
// toastBulkOutcome without a bespoke presenter): an item counts as succeeded only once EVERY selected
// contact received it; if any of its contact-shares rejects, the item lands in `failed` (runBulk's
// per-item throw contract stops that item's remaining contacts — a partial item-level state the toast
// reports as failed, so the user re-shares it rather than silently missing recipients).
//
// The Rust SDK owns networking/retries/rate-limiting/concurrency — this only iterates the user's N×M
// chosen shares (mobile parity; there is no AbortSignal on the wasm share ops, and dir-share passes no
// progress callback). Item-level parallelism reuses the established runBulk runner; each item's
// contacts share in a plain sequential loop. No bespoke concurrency machinery.
export async function shareItems(items: DriveItem[], contacts: Contact[]): Promise<BulkOutcome<DriveItem>> {
	const outcome = await runBulk(items, async item => {
		const base = asDirectoryOrFile(item)

		for (const contact of contacts) {
			await runOp(base.type === "directory" ? sdkApi.shareDirectory(base.data, contact) : sdkApi.shareFile(base.data, contact))
		}
	})

	// A freshly shared item becomes a new top-level entry in the sharer's Shared-with-others root
	// listing (keyed uuid: null) — invalidate it so it refetches when next viewed, rather than
	// optimistically reconstructing a SharedRootItem (error-prone: the wasm result carries share
	// context this side can't fully rebuild). Nested shared-out listings show an already-shared
	// directory's own children and are unaffected by a new top-level share, so only the root is
	// targeted. Skipped when nothing succeeded (nothing changed server-side). Fire-and-forget, same as
	// renameItem's names-cache invalidation: invalidateQueries resolves even when the refetch it
	// triggers fails (the query's own error state absorbs that), so it must not gate this helper's own
	// success resolution.
	if (outcome.succeeded.length > 0) {
		void queryClient.invalidateQueries({ queryKey: driveListingQueryKey({ variant: "sharedOut", uuid: null }) })
	}

	return outcome
}
