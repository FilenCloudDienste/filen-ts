import { formatBytes, resolveQuotaVerdict, type QuotaCheckDeps, type QuotaVerdict } from "@filen/shared"
import { i18n } from "@/lib/i18n"
import { accountQueryGet, accountQueryUpdate, fetchAccountFresh, isAccountReadRecent } from "@/queries/account"
import { openStorageFull } from "@/features/shell/store/useReminderStore"

// The fresh read also refreshes every other account consumer, unless the account was written meanwhile.
// A cached "fits" older than this page's last recent read (a restored persisted account above all) is
// read again, so a delete or upload made elsewhere cannot leave it trusting old figures.
export const accountQuotaDeps: QuotaCheckDeps = {
	cached: accountQueryGet,
	fetchFresh: fetchAccountFresh,
	isCachedFresh: isAccountReadRecent
}

// Upload pre-flight against the cached account; see resolveQuotaVerdict for when it reads fresh.
export function checkUploadQuota(neededBytes: bigint): Promise<QuotaVerdict> {
	return resolveQuotaVerdict(accountQuotaDeps, neededBytes)
}

export function quotaExceededMessage(verdict: Extract<QuotaVerdict, { status: "exceeds" }>): string {
	return i18n.t("transfers:transfersQuotaExceeded", {
		needed: formatBytes(Number(verdict.neededBytes)),
		free: formatBytes(Number(verdict.freeBytes))
	})
}

// A pre-flight refusal, on the storage-full dialog every refusal shows, with how much was needed and is free.
export function refuseForQuota(verdict: Extract<QuotaVerdict, { status: "exceeds" }>): void {
	openStorageFull(quotaExceededMessage(verdict))
}

// For entry points with no outcome of their own to carry the refusal: shows it and returns false.
export async function ensureUploadQuota(neededBytes: bigint): Promise<boolean> {
	const verdict = await checkUploadQuota(neededBytes)

	if (verdict.status !== "exceeds") {
		return true
	}

	refuseForQuota(verdict)

	return false
}

// Lets the next pre-flight see this upload without a read. The refresh markAccountStale queued stays
// pending for the next focus, mount or reconnect, so the server's own figure replaces this estimate then
// rather than with a read per file; readNow reads at once instead.
export function addAccountStorageUsed(bytes: bigint, options?: { readNow?: boolean }): void {
	accountQueryUpdate(prev => ({ ...prev, storageUsed: prev.storageUsed + bytes }), {
		readNow: options?.readNow ?? false
	})
}
