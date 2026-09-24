import { type PublicLinkExpiration } from "@filen/sdk-rs"

/**
 * Returns whether an expiration enum value should be shown as checked in the
 * expiration dropdown.
 *
 * When the user has made a local selection (`editedExpiration` is defined) it
 * is the sole source of truth — the server's current value is ignored so that
 * exactly one item is checked while edits are pending.  When no local
 * selection exists, falls back to the server value.
 */
export function isExpirationChecked({
	candidate,
	editedExpiration,
	serverExpiration
}: {
	candidate: PublicLinkExpiration
	editedExpiration: PublicLinkExpiration | undefined
	serverExpiration: PublicLinkExpiration | undefined
}): boolean {
	if (editedExpiration !== undefined) {
		return editedExpiration === candidate
	}

	if (serverExpiration !== undefined) {
		return serverExpiration === candidate
	}

	return false
}

/**
 * Returns whether the public-link screen should show its error state rather
 * than a loading spinner.
 *
 * Both queries must have settled into an error status (not just one) before
 * we switch from spinner to error, because a single slow query may still
 * succeed.  However, if either is in error and the other has already succeeded
 * there is no benefit in continuing to spin — show the error immediately.
 */
export function isPublicLinkQueryError(
	publicLinkStatus: "pending" | "error" | "success",
	account: "pending" | "error" | "success"
): boolean {
	return publicLinkStatus === "error" || account === "error"
}

type LinkStatusQuery<T> = {
	status: "pending" | "error" | "success"
	fetchStatus: "fetching" | "paused" | "idle"
	data: T | undefined
	refetch: (options: { cancelRefetch: boolean }) => Promise<{ data: T | undefined }>
}

/**
 * The link status the screen holds, when it is current: its mount read has settled. Until then the
 * value may be a persisted row from before a change made on another device, which enable and disable
 * must not trust in place of their own read.
 */
export function currentHeldLinkStatus<T>(query: LinkStatusQuery<T>): { current: true; value: T | undefined } | { current: false } {
	if (query.status !== "success" || query.fetchStatus !== "idle") {
		return {
			current: false
		}
	}

	return {
		current: true,
		value: query.data
	}
}

/**
 * The link status to build a save from: the held one when current, else the read in flight (joined,
 * not restarted), so a save never writes back fields a newer server state has replaced.
 */
export async function linkStatusForWrite<T>(query: LinkStatusQuery<T>): Promise<T | undefined> {
	const held = currentHeldLinkStatus(query)

	if (held.current) {
		return held.value
	}

	return (
		await query.refetch({
			cancelRefetch: false
		})
	).data
}
