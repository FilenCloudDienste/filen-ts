import { toast } from "sonner"
import type { GetItemPathResult } from "@filen/sdk-rs"
import { queryClient } from "@/queries/client"
import { asErrorDTO, type ErrorDTO } from "@/lib/sdk/errors"
import { errorLabel } from "@/lib/i18n/errorLabel"
import { asDirectoryOrFile, type DriveItem } from "@/features/drive/lib/item"
import { parentNavigationTarget, type DriveNavigationTarget } from "@/features/drive/lib/navigate"
import { useDriveStore } from "@/features/drive/store/useDriveStore"
import { fetchItemPath, itemPathQueryKey } from "@/features/drive/queries/drive"

// Injected so the resolver below is exercisable without a query client.
export interface RevealDeps {
	fetchPath: (item: DriveItem) => Promise<GetItemPathResult>
}

// ensureQueryData so a repeated reveal of the same item (or a second one from the same result set) is
// a cache read — the same shape itemMenu.tsx's runCopyLink already uses for the link status.
export const defaultRevealDeps: RevealDeps = {
	fetchPath: item =>
		queryClient.ensureQueryData({
			queryKey: itemPathQueryKey(item.data.uuid),
			queryFn: () => fetchItemPath(asDirectoryOrFile(item).data)
		})
}

export type RevealTargetOutcome = { status: "success"; target: DriveNavigationTarget } | { status: "error"; dto: ErrorDTO }

// "Open containing directory" for a search hit: the destination is built from the SDK's own ancestor
// chain (the same chain the Info dialog's Location row reads), never from `item.data.parent` — a
// single parent uuid would produce a one-segment splat and truncate the breadcrumb. A failed walk is
// an error outcome, not an empty chain: the caller must toast instead of silently landing on My
// Drive's root. A SUCCESSFUL walk with an empty chain still means what it says — the item sits at the
// drive root — and resolving the root splat for it is correct.
export async function resolveContainingDirectoryTarget(deps: RevealDeps, item: DriveItem): Promise<RevealTargetOutcome> {
	try {
		const result = await deps.fetchPath(item)

		return { status: "success", target: parentNavigationTarget(result.ancestors) }
	} catch (e) {
		return { status: "error", dto: asErrorDTO(e) }
	}
}

// The whole "Open containing directory" dispatch, kept out of the menu component so the failure arm
// (toast, no navigation, NO armed reveal) is exercisable without rendering an open Base UI menu.
// `navigate` is the caller's own router navigate.
export async function runOpenContainingDirectory(
	deps: RevealDeps,
	item: DriveItem,
	navigate: (target: DriveNavigationTarget) => void
): Promise<void> {
	const outcome = await resolveContainingDirectoryTarget(deps, item)

	if (outcome.status === "error") {
		toast.error(errorLabel(outcome.dto))
		return
	}

	// Armed only on the success arm — the destination listing consumes it once and reveals the row.
	useDriveStore.getState().requestReveal({ uuid: item.data.uuid, splat: outcome.target.params._splat })
	navigate(outcome.target)
}
