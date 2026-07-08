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
// contact received it; if any of its contact-shares rejects, the item lands in `failed`. Every contact
// is still attempted even after an earlier one rejects — a mid-list rejection must not strand contacts
// later in the list untried, or a retry could keep re-sharing to already-shared recipients and never
// reach the ones that were never given a chance. The FIRST rejection's already-normalized ErrorDTO is
// what surfaces on the item (LABEL-FIRST); later rejections are swallowed once one is captured.
//
// The Rust SDK owns networking/retries/rate-limiting/concurrency — this only iterates the user's N×M
// chosen shares (mobile parity; there is no AbortSignal on the wasm share ops, and dir-share passes no
// progress callback). Item-level parallelism reuses the established runBulk runner; each item's
// contacts share in a plain sequential loop, catching per-contact so one rejection never stops the
// loop early. No bespoke concurrency machinery.
export async function shareItems(items: DriveItem[], contacts: Contact[]): Promise<BulkOutcome<DriveItem>> {
	const outcome = await runBulk(items, async item => {
		const base = asDirectoryOrFile(item)
		let firstError: unknown

		for (const contact of contacts) {
			try {
				await runOp(base.type === "directory" ? sdkApi.shareDirectory(base.data, contact) : sdkApi.shareFile(base.data, contact))
			} catch (error) {
				firstError ??= error
			}
		}

		if (firstError !== undefined) {
			// Rethrowing runOp's own already-normalized ErrorDTO, same rationale as runOp's own rethrow.
			// eslint-disable-next-line @typescript-eslint/only-throw-error -- deliberate, see above
			throw firstError
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
