// jsdom lays nothing out, so a virtualized list renders no rows: these give every element a fixed client size the
// virtualizer can window over. Returns the restore.
export function stubElementSize(sizes: { clientHeight: number; clientWidth: number }): () => void {
	const originals = new Map<string, PropertyDescriptor | undefined>()

	for (const [name, size] of Object.entries(sizes)) {
		originals.set(name, Object.getOwnPropertyDescriptor(HTMLElement.prototype, name))
		Object.defineProperty(HTMLElement.prototype, name, { configurable: true, get: () => size })
	}

	return () => {
		for (const [name, descriptor] of originals) {
			if (descriptor !== undefined) {
				Object.defineProperty(HTMLElement.prototype, name, descriptor)
			}
		}
	}
}
