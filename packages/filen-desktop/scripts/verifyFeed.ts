import { readdir, readFile } from "node:fs/promises"
import path from "node:path"
import { Readable } from "node:stream"
import type { ReadableStream as WebReadableStream } from "node:stream/web"
import { setTimeout as sleep } from "node:timers/promises"
import { hashStream, parseFeed } from "./feed.ts"

// Reads the published feed back the way an installed client does: each manifest must be byte-identical to the one
// released, and every file it lists must download with the listed sha512 and size. Manifests are retried for a while
// so a CDN still serving the previous release is not mistaken for a failure.
//
//   node scripts/verifyFeed.ts <dir> <feed url>

const [dir, feedArg] = process.argv.slice(2)

if (!dir || !feedArg) {
	console.error("usage: node scripts/verifyFeed.ts <dir> <feed url>")
	process.exit(1)
}

const feedUrl = feedArg.endsWith("/") ? feedArg : `${feedArg}/`
const attempts = 20
const retryDelayMs = 30_000
const failures: string[] = []

async function fetchFresh(name: string): Promise<Response> {
	return fetch(new URL(encodeURIComponent(name), feedUrl), { cache: "no-store", headers: { "Cache-Control": "no-cache" } })
}

async function remoteManifest(name: string, local: string): Promise<boolean> {
	for (let attempt = 1; attempt <= attempts; attempt++) {
		const response = await fetchFresh(name).catch((error: unknown) => {
			console.log(`${name}: ${error instanceof Error ? error.message : String(error)}`)

			return null
		})
		const text = response?.ok ? await response.text() : null

		if (text === local) {
			console.log(`${name}: published copy matches`)

			return true
		}

		console.log(`${name}: ${text === null ? `HTTP ${response?.status ?? "error"}` : "differs"} (attempt ${attempt}/${attempts})`)

		if (attempt < attempts) {
			await sleep(retryDelayMs)
		}
	}

	return false
}

const manifests = (await readdir(dir)).filter(name => /^latest.*\.yml$/.test(name)).sort()

if (manifests.length === 0) {
	failures.push(`no latest*.yml in ${dir}`)
}

for (const manifest of manifests) {
	const local = await readFile(path.join(dir, manifest), "utf8")

	if (!(await remoteManifest(manifest, local))) {
		failures.push(`${feedUrl}${manifest} does not match the released manifest`)

		continue
	}

	for (const file of parseFeed(local, manifest).files) {
		const response = await fetchFresh(file.url)

		if (!response.ok || !response.body) {
			failures.push(`${feedUrl}${file.url}: HTTP ${response.status}`)

			continue
		}

		const actual = await hashStream(Readable.fromWeb(response.body as WebReadableStream<Uint8Array>))

		if (actual.size !== file.size || actual.sha512 !== file.sha512) {
			failures.push(`${feedUrl}${file.url}: served bytes do not match ${manifest} (size ${actual.size}, expected ${file.size})`)
		} else {
			console.log(`${file.url}: served copy matches (${actual.size} bytes)`)
		}
	}
}

if (failures.length > 0) {
	for (const failure of failures) {
		console.error(`::error::${failure}`)
	}

	process.exit(1)
}
