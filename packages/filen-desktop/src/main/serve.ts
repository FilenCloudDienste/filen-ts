import { protocol, net } from "electron"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { headersFor, type HeaderRule } from "./headers.ts"

export interface RequestInfo {
	method: string
	secFetchMode: string | null
	accept: string
}

export type Resolution =
	{ kind: "file"; relPath: string; onMissing: "index" | "notFound" } | { kind: "brokenDownload" } | { kind: "notFound" }

// The service worker owns /sw/ (filen-web src/lib/sw/protocol.ts). A request for it that reaches the shell is one
// the worker never saw; the page navigates to that URL to save, so anything but a failed load replaces the app.
const SW_PREFIX = "/sw/"

// Mirrors filen-web/cloudflare/worker.ts: a navigation that matches no file gets the SPA's index.html, any other
// miss a real 404, so a stale hashed asset is never answered with HTML.
function isNavigation(request: RequestInfo): boolean {
	if (request.secFetchMode !== null) {
		return request.secFetchMode === "navigate"
	}

	return request.method === "GET" && request.accept.includes("text/html")
}

export function resolveRequest(pathname: string, request: RequestInfo): Resolution {
	if (request.method !== "GET" && request.method !== "HEAD") {
		return { kind: "notFound" }
	}

	let decoded: string

	try {
		decoded = decodeURIComponent(pathname)
	} catch {
		return { kind: "notFound" }
	}

	if (decoded.split(/[/\\]/).includes("..")) {
		return { kind: "notFound" }
	}

	if (decoded.startsWith(SW_PREFIX)) {
		return { kind: "brokenDownload" }
	}

	const relPath = decoded === "/" ? "index.html" : decoded.slice(1)

	return { kind: "file", relPath, onMissing: isNavigation(request) ? "index" : "notFound" }
}

async function fetchFile(distDir: string, relPath: string): Promise<Response | null> {
	try {
		const response = await net.fetch(pathToFileURL(path.join(distDir, relPath)).toString())

		return response.ok ? response : null
	} catch {
		return null
	}
}

function withHeaders(response: Response, extra: Record<string, string>): Response {
	const headers = new Headers(response.headers)

	for (const [name, value] of Object.entries(extra)) {
		headers.set(name, value)
	}

	return new Response(response.body, { status: response.status, headers })
}

// Development against filen-web's Vite server (scripts/dev.ts): the page keeps the app's origin, which IPC trust and
// the storage partition are keyed on, while every request is answered by Vite with its own headers and SPA fallback.
export function devServerUrl(requestUrl: string, devOrigin: string): string | null {
	const { pathname, search } = new URL(requestUrl)

	return pathname.startsWith(SW_PREFIX) ? null : new URL(pathname + search, devOrigin).toString()
}

export function registerDevProxy(scheme: string, devOrigin: string): void {
	protocol.handle(scheme, request => {
		const target = devServerUrl(request.url, devOrigin)

		if (target === null) {
			return Response.error()
		}

		const headers = new Headers(request.headers)

		headers.delete("origin")

		return net.fetch(target, { method: request.method, headers, bypassCustomProtocolHandlers: true })
	})
}

export function registerAppProtocol(scheme: string, distDir: string, rules: readonly HeaderRule[]): void {
	protocol.handle(scheme, async request => {
		const { pathname } = new URL(request.url)
		const resolution = resolveRequest(pathname, {
			method: request.method,
			secFetchMode: request.headers.get("sec-fetch-mode"),
			accept: request.headers.get("accept") ?? ""
		})

		if (resolution.kind === "brokenDownload") {
			return Response.error()
		}

		const notFound = new Response(null, { status: 404, headers: { "cache-control": "no-store" } })

		if (resolution.kind === "notFound") {
			return notFound
		}

		const file =
			(await fetchFile(distDir, resolution.relPath)) ??
			(resolution.onMissing === "index" ? await fetchFile(distDir, "index.html") : null)

		return file === null ? notFound : withHeaders(file, headersFor(rules, pathname))
	})
}
