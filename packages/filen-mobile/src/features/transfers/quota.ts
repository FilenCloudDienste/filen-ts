import { formatBytes, resolveQuotaVerdict, sumBytes } from "@filen/shared"
import i18n from "@/lib/i18n"
import { accountQuotaDeps } from "@/queries/useAccount.query"

// The one wording for a refused upload or copy.
export function notEnoughStorageMessage(neededBytes: bigint | number, freeBytes: bigint | number): string {
	return i18n.t("not_enough_storage", {
		needed: formatBytes(Number(neededBytes)),
		free: formatBytes(Number(freeBytes))
	})
}

// A copy refused before its size was reported: only the free storage it was checked against is known.
export function copyDoesNotFitMessage(freeBytes: number): string {
	return i18n.t("copy_quota_exceeded", {
		free: formatBytes(freeBytes)
	})
}

/**
 * Checks a manual upload against the account's free storage before any transfer row exists: a fresh
 * cached figure answers without a request, a stale or refusing one is read once. Returns the refusal
 * message, or null when it fits or the quota can't be told (the server then decides). Sizes a file
 * can't report count as 0.
 */
export async function uploadQuotaRefusal(sizes: readonly (number | null | undefined)[]): Promise<string | null> {
	const needed = sumBytes(sizes.map(size => (typeof size === "number" && size > 0 ? size : 0)))

	if (needed === 0n) {
		return null
	}

	const verdict = await resolveQuotaVerdict(accountQuotaDeps, needed)

	return verdict.status === "exceeds" ? notEnoughStorageMessage(verdict.neededBytes, verdict.freeBytes) : null
}
