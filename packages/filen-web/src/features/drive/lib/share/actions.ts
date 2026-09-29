import type { Contact } from "@filen/sdk-rs"
import { sdkApi } from "@/lib/sdk/client"
import { queryClient } from "@/queries/client"
import { batchListingPatches, driveListingQueryKey, rootListingQueryUpdate } from "@/features/drive/queries/drive"
import { asDirectoryOrFile, isSharedRootDriveItem, type DriveItem } from "@/features/drive/lib/item"
import { driveRowKey } from "@/features/drive/lib/rowKey"
import { type DriveVariant } from "@/features/drive/lib/preferences"
import { runOp } from "@/lib/actions/outcome"
import { runBulk, type BulkOutcome } from "@/lib/actions/bulk"

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

// Stops sharing a shared-root item — a directory shared out, or an item shared in the caller wants
// gone. Root-only: itemMenu.logic.ts/bulkActionBar.logic.ts gate this action to isSharedRootDriveItem
// — the type guard below is a defense-in-depth backstop for a caller bug, never a state the real gated
// callers can reach.
//
// `item.data.shareSource`, never `item.data` itself, is what crosses to the worker: removeSharedItem
// forwards its argument straight to the SDK, which deserializes SharedRootItem as an UNTAGGED union —
// the flattened `data` a directory arm carries has no `inner`, matching neither SharedRootDir nor
// SharedFile (see item.ts).
export function unshareItems(items: DriveItem[], variant: DriveVariant): Promise<BulkOutcome<DriveItem>> {
	return batchListingPatches(() =>
		runBulk(items, async item => {
			if (!isSharedRootDriveItem(item)) {
				throw new Error(`unshareItems: item type "${item.type}" has no share source`)
			}

			await runOp(sdkApi.removeSharedItem(item.data.shareSource))

			// This row vanishes from the shared ROOT listing it lives in (sharedIn or sharedOut, whichever
			// `variant` names) — no cross-surface patch needed, unlike a normal drive write: removing a share
			// never touches an owned listing. Only this row: the Shared by me root lists an item once per
			// receiver, and the share removed is this row's receiver's alone. Through the patch path, so a read
			// under way drops it too; a listing nobody has viewed yet is left alone.
			const key = driveRowKey(item)

			rootListingQueryUpdate(variant, rows => {
				const kept = rows.filter(row => row.data.uuid !== item.data.uuid || driveRowKey(row) !== key)

				return kept.length === rows.length ? rows : kept
			})
		})
	)
}
