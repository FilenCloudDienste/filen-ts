import { describe, expect, it } from "vitest"
import { devServerUrl, resolveRequest } from "../main/serve.ts"

const navigation = { method: "GET", secFetchMode: "navigate", accept: "text/html" }
const subresource = { method: "GET", secFetchMode: "no-cors", accept: "*/*" }

describe("resolveRequest", () => {
	it("serves index.html for the root", () => {
		expect(resolveRequest("/", navigation)).toEqual({ kind: "file", relPath: "index.html", onMissing: "index" })
	})

	it("falls back to index.html for a deep-link navigation", () => {
		expect(resolveRequest("/drive/abc", navigation)).toEqual({ kind: "file", relPath: "drive/abc", onMissing: "index" })
	})

	it("treats a GET without Sec-Fetch-Mode that accepts HTML as a navigation", () => {
		expect(resolveRequest("/notes", { method: "GET", secFetchMode: null, accept: "text/html,*/*" })).toMatchObject({
			onMissing: "index"
		})
	})

	it("404s a missing asset instead of answering with HTML", () => {
		expect(resolveRequest("/assets/old-123.js", subresource)).toEqual({
			kind: "file",
			relPath: "assets/old-123.js",
			onMissing: "notFound"
		})
	})

	it("fails a download the service worker never saw", () => {
		expect(resolveRequest("/sw/download/x", navigation)).toEqual({ kind: "brokenDownload" })
	})

	it.each(["/../../etc/passwd", "/%2e%2e/%2e%2e/etc/passwd", "/assets/..%2f..%2fsecret", "/%E0%A4%A"])("refuses %s", pathname => {
		expect(resolveRequest(pathname, subresource)).toEqual({ kind: "notFound" })
	})

	it("refuses methods other than GET and HEAD", () => {
		expect(resolveRequest("/", { ...navigation, method: "POST" })).toEqual({ kind: "notFound" })
	})
})

describe("devServerUrl", () => {
	it("maps the app's path and query onto the dev server", () => {
		expect(devServerUrl("filen://app/src/main.tsx?t=1", "http://localhost:5173")).toBe("http://localhost:5173/src/main.tsx?t=1")
		expect(devServerUrl("filen://app/", "http://localhost:5173")).toBe("http://localhost:5173/")
	})

	it("fails a download the service worker never saw", () => {
		expect(devServerUrl("filen://app/sw/download/abc", "http://localhost:5173")).toBeNull()
	})
})
