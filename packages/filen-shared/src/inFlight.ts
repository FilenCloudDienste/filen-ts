// Single-flight (in-flight promise coalescing): join a promise already running for a key instead of
// starting a second one, keyed by an app-supplied cacheKey and generic over the resolved value so no
// platform or SDK type needs to cross into this module.
export class InFlight<K, V> {
	private readonly map = new Map<K, Promise<V>>()

	public get(key: K): Promise<V> | undefined {
		return this.map.get(key)
	}

	public has(key: K): boolean {
		return this.map.has(key)
	}

	// Returns the in-flight promise for key if one exists, otherwise starts fn(), registers its
	// promise BEFORE awaiting it, and removes the entry once settled — but only if it is still the
	// one this call registered, so a slow, superseded promise can never evict a newer entry.
	public async coalesce(key: K, fn: () => Promise<V>): Promise<V> {
		const existing = this.map.get(key)

		if (existing) {
			return existing
		}

		const promise = fn()

		this.map.set(key, promise)

		try {
			return await promise
		} finally {
			if (this.map.get(key) === promise) {
				this.map.delete(key)
			}
		}
	}
}

export default InFlight
