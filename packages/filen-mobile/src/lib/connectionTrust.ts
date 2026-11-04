/**
 * Whether the last word on the connection to Filen is a certificate the platform verifier rejected
 * (an intercepting proxy, a captive portal, a revoked chain). The device is online, so this is its
 * own state in the offline indicator, never "offline". Marked when an SDK error of the TLS
 * verification kind (sdkErrors.isTlsVerificationError) reaches the query cache or an error alert.
 * Cleared when the socket authenticates (a verified round trip) and on going offline, after which
 * the next network is unproven. Query successes do not clear it: many queryFns are local and prove
 * nothing about the connection. Dependency-free, so infra that only clears it does not pull in the SDK.
 */
export class ConnectionTrust {
	private unverified = false
	private readonly listeners = new Set<() => void>()

	public isUnverified(): boolean {
		return this.unverified
	}

	public subscribe(listener: () => void): () => void {
		this.listeners.add(listener)

		return () => {
			this.listeners.delete(listener)
		}
	}

	public markUnverified(): void {
		this.set(true)
	}

	public clear(): void {
		this.set(false)
	}

	private set(unverified: boolean): void {
		if (this.unverified === unverified) {
			return
		}

		this.unverified = unverified

		for (const listener of this.listeners) {
			listener()
		}
	}
}

const connectionTrust = new ConnectionTrust()

export default connectionTrust
