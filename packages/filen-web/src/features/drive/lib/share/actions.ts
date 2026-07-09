import type { Contact } from "@filen/sdk-rs"
import { sdkApi } from "@/lib/sdk/client"
import { queryClient } from "@/queries/client"
import { driveListingQueryKey } from "@/features/drive/queries/drive"
import { asDirectoryOrFile, type DriveItem } from "@/features/drive/lib/item"
import { type DriveVariant } from "@/features/drive/lib/preferences"
import { runOp } from "@/lib/actions/outcome"
import { runBulk, type BulkOutcome } from "@/features/drive/lib/bulk"

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

// Filters a cached shared-root listing down to every row except the given uuid — a local, standalone
// copy of drive/actions.ts's own private removeByUuid (unexported there, and this file already stands
// alone from drive/actions.ts's write helpers, same as shareItems above).
function removeByUuid(items: DriveItem[], uuid: string): DriveItem[] {
	return items.filter(item => item.data.uuid !== uuid)
}

// Stops sharing a shared-root item — a directory shared out, or an item shared in the caller wants
// gone. Root-only: item-menu.logic.ts/bulk-action-bar.logic.ts gate this action to the
// sharedRootDirectory/sharedRootFile arms alone, the only two whose shareSource is a SharedRootItem
// (see item.ts's union doc comment) — the type guard below is a defense-in-depth backstop for a caller
// bug, never a state the real gated callers can reach.
//
// `item.data.shareSource`, never `item.data` itself, is what crosses to the worker: removeSharedItem
// forwards its argument straight to the SDK, which deserializes SharedRootItem as an UNTAGGED union —
// the flattened `data` a directory arm carries has no `inner`, matching neither SharedRootDir nor
// SharedFile (see item.ts).
export function unshareItems(items: DriveItem[], variant: DriveVariant): Promise<BulkOutcome<DriveItem>> {
	return runBulk(items, async item => {
		if (item.type !== "sharedRootDirectory" && item.type !== "sharedRootFile") {
			throw new Error(`unshareItems: item type "${item.type}" has no share source`)
		}

		await runOp(sdkApi.removeSharedItem(item.data.shareSource))

		// The item vanishes from the shared ROOT listing it lives in (sharedIn or sharedOut, whichever
		// `variant` names) — no cross-surface patch needed, unlike a normal drive write: removing a
		// share never touches an owned listing. `prev === undefined` (nobody has viewed this listing
		// yet) is left alone rather than conjuring a `[]`, same rationale as driveListingQueryUpdate.
		queryClient.setQueryData<DriveItem[]>(driveListingQueryKey({ variant, uuid: null }), prev =>
			prev === undefined ? prev : removeByUuid(prev, item.data.uuid)
		)
	})
}
