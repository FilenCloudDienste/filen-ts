import { classifyResourceUrl, decodeDataUrl, resourceBudget } from "@/lib/workers/resourceSandbox.logic"

// Installed first in a viewer worker that runs a third-party loader. The loader's fetch of a blob: or data: URL (which
// connect-src refuses) is answered locally, a `filen-ref:///<path>` reference through `resolve`, a same-origin asset
// through the real fetch; anything else is refused and counted. connect-src stays the security boundary: the sandbox
// is the fetch shim and the reporter.

export class ExternalReferenceBlockedError extends Error {
	public constructor() {
		super("external reference blocked")
		this.name = "ExternalReferenceBlocked"
	}
}

export class ResourceBudgetExceededError extends Error {
	public constructor() {
		super("referenced resources exceed the viewer's budget")
		this.name = "ResourceBudgetExceeded"
	}
}

export interface ResourceSandboxOptions {
	// Same-origin path prefixes passed to the real fetch.
	readonly assets: readonly string[]
	// A referenced file's bytes, or null when it is missing.
	readonly resolve: (path: string) => Promise<Blob | null>
	// Bytes of registered blobs, decoded data: URLs and resolved references together.
	readonly budget: number
}

export interface ResourceSandbox {
	// External requests refused so far (fetches and XMLHttpRequest/WebSocket/EventSource constructions).
	blocked(): number
}

function requestUrl(input: RequestInfo | URL): string {
	if (input instanceof Request) {
		return input.url
	}

	return input instanceof URL ? input.href : input
}

export function installResourceSandbox({ assets, resolve, budget: limit }: ResourceSandboxOptions): ResourceSandbox {
	const realFetch = globalThis.fetch.bind(globalThis)
	const realCreate = URL.createObjectURL.bind(URL)
	const realRevoke = URL.revokeObjectURL.bind(URL)
	const budget = resourceBudget(limit)
	const registered = new Map<string, Blob>()
	let blocked = 0

	function refuse(): never {
		blocked++

		throw new ExternalReferenceBlockedError()
	}

	globalThis.fetch = async (input, init) => {
		init?.signal?.throwIfAborted()

		const request = classifyResourceUrl(requestUrl(input), globalThis.location.href, assets)

		switch (request.kind) {
			case "blob": {
				const blob = registered.get(request.href)

				return blob === undefined ? refuse() : new Response(blob)
			}

			case "data": {
				const decoded = decodeDataUrl(request.href, budget.remaining)

				if (decoded.status === "malformed") {
					throw new TypeError("malformed data: URL")
				}

				if (decoded.status === "overBudget" || !budget.take(decoded.bytes.byteLength)) {
					throw new ResourceBudgetExceededError()
				}

				return new Response(decoded.bytes, { headers: { "Content-Type": decoded.type } })
			}

			case "ref": {
				const blob = await resolve(request.path)

				if (blob === null) {
					return new Response(null, { status: 404 })
				}

				if (!budget.take(blob.size)) {
					throw new ResourceBudgetExceededError()
				}

				return new Response(blob)
			}

			case "asset": {
				return await realFetch(input, init)
			}

			case "external": {
				return refuse()
			}
		}
	}

	URL.createObjectURL = (object: Blob | MediaSource) => {
		if (!(object instanceof Blob)) {
			return realCreate(object)
		}

		if (!budget.take(object.size)) {
			throw new ResourceBudgetExceededError()
		}

		const url = realCreate(object)

		registered.set(url, object)

		return url
	}
	URL.revokeObjectURL = (url: string) => {
		const blob = registered.get(url)

		if (blob !== undefined) {
			registered.delete(url)
			budget.give(blob.size)
		}

		realRevoke(url)
	}

	// Throwing constructors: none of these is answered locally.
	const Refused = function Refused(): never {
		return refuse()
	}

	Object.assign(globalThis, { XMLHttpRequest: Refused, WebSocket: Refused, EventSource: Refused })

	return { blocked: () => blocked }
}
