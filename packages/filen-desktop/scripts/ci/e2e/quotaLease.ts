import { randomBytes } from "node:crypto"
import { CLOUD_ROOT, type Cloud } from "./cloud.ts"
import { runId } from "./session.ts"

// The quota account is one account for every run: the nightly, dispatches and releases each have their own concurrency
// group, so two of them can reach P17 together, and one would delete the filler or fill the account under the other.
// A lease serialises them: each run adds an empty directory named `<start ms, padded>-<run>-<attempt>-<nonce>` to
// LEASE_DIR, lists it and holds the account only when its own name sorts first among the unexpired ones; otherwise it
// removes its own and P17 is skipped. Two runs adding theirs at once both list both, so exactly one holds it. A run
// killed while holding it keeps the account for LEASE_MS at most. Empty directories take no storage.

export const LEASE_DIR = `${CLOUD_ROOT}-quota-lease`
// Longer than P17 ever takes (its waits add up to about 30 minutes).
export const LEASE_MS = 60 * 60 * 1000

export function leaseName(now: number, run: string, nonce: string): string {
	return `${String(now).padStart(15, "0")}-${run}-${nonce}`
}

// When the lease was taken, from its name; null for a name that is not a lease.
export function leaseStart(name: string): number | null {
	const match = /^(\d{15})-/.exec(name)

	return match?.[1] === undefined ? null : Number(match[1])
}

// The leases past LEASE_MS (or not leases at all), to remove, and the one holding the account, if any.
export function leaseState(names: readonly string[], now: number): { expired: string[]; holder: string | null } {
	const expired: string[] = []
	const live: string[] = []

	for (const name of names) {
		const start = leaseStart(name)

		;(start === null || now - start > LEASE_MS ? expired : live).push(name)
	}

	return { expired, holder: live.sort()[0] ?? null }
}

export interface QuotaLease {
	release(): Promise<void>
}

// The account's lease for this run, or the name of the run holding it.
export async function takeQuotaLease(cloud: Cloud): Promise<{ lease: QuotaLease } | { heldBy: string }> {
	const before = leaseState(
		((await cloud.list(LEASE_DIR, false)) ?? []).filter(entry => entry.isDir).map(entry => entry.path),
		Date.now()
	)

	for (const name of before.expired) {
		await cloud.purge(`${LEASE_DIR}/${name}`)
	}

	const mine = leaseName(Date.now(), `${runId()}-${process.env["GITHUB_RUN_ATTEMPT"] ?? "1"}`, randomBytes(4).toString("hex"))
	const release = () => cloud.purge(`${LEASE_DIR}/${mine}`)

	await cloud.mkdir(`${LEASE_DIR}/${mine}`)

	const { holder } = leaseState(
		((await cloud.list(LEASE_DIR, false)) ?? []).filter(entry => entry.isDir).map(entry => entry.path),
		Date.now()
	)

	if (holder === mine) {
		return { lease: { release } }
	}

	await release()

	return { heldBy: holder ?? "nobody (this run's lease is not listed)" }
}
