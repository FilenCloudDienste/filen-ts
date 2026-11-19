import type { Page } from "@playwright/test"
import { waitForE2eHooks } from "./e2eHooks"

// A document password used as a canary: the specs that type one assert it reaches no console message, request
// (URL or body, as UTF-8 or UTF-16LE: Office derives keys from the UTF-16LE form) and no storage: local, session,
// IndexedDB and the OPFS SQLite kv the app persists to. The page's own and its workers' requests are seen (the SDK's
// run in a worker). The OPFS blob store outside the kv (src/lib/storage/opfsBlobStore.ts) is not scanned.

export interface PasswordCanary {
	// Where the password was seen so far: "console: …", "request: <url>".
	readonly leaks: string[]
}

function encodings(password: string): Buffer[] {
	return [Buffer.from(password, "utf8"), Buffer.from(password, "utf16le")]
}

export function trackPasswordCanary(page: Page, password: string): PasswordCanary {
	const leaks: string[] = []
	const needles = encodings(password)

	page.on("console", message => {
		if (message.text().includes(password)) {
			leaks.push(`console: ${message.text()}`)
		}
	})
	page.context().on("request", request => {
		const url = request.url()
		const body = request.postDataBuffer()

		if (url.includes(password) || url.includes(encodeURIComponent(password))) {
			leaks.push(`request url: ${url}`)
		}

		if (body !== null && needles.some(needle => body.includes(needle))) {
			leaks.push(`request body: ${url}`)
		}
	})

	return { leaks }
}

// Every value in localStorage, sessionStorage and the origin's IndexedDB databases that holds the password
// (strings as they are, binary as UTF-8 and UTF-16LE), and every kv row whose key or stored value does
// (src/e2e-hooks/kvScan.ts).
export async function storedPassword(page: Page, password: string): Promise<string[]> {
	await waitForE2eHooks(page)

	return await page.evaluate(async secret => {
		const found: string[] = []
		const utf16 = new TextDecoder("utf-16le")
		const utf8 = new TextDecoder()
		const holds = (value: unknown, depth: number): boolean => {
			if (typeof value === "string") {
				return value.includes(secret)
			}

			if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
				const bytes =
					value instanceof ArrayBuffer ? new Uint8Array(value) : new Uint8Array(value.buffer, value.byteOffset, value.byteLength)

				return utf8.decode(bytes).includes(secret) || utf16.decode(bytes).includes(secret)
			}

			if (value instanceof Blob || value === null || typeof value !== "object" || depth > 32) {
				return false
			}

			return Object.values(value).some(entry => holds(entry, depth + 1))
		}

		for (const storage of [localStorage, sessionStorage]) {
			for (let index = 0; index < storage.length; index++) {
				const key = storage.key(index) ?? ""

				if (holds(key, 0) || holds(storage.getItem(key), 0)) {
					found.push(`web storage: ${key}`)
				}
			}
		}

		for (const { name } of await indexedDB.databases()) {
			if (name === undefined) {
				continue
			}

			const database = await new Promise<IDBDatabase>((resolve, reject) => {
				const opening = indexedDB.open(name)

				opening.onsuccess = () => {
					resolve(opening.result)
				}
				opening.onerror = () => {
					reject(opening.error ?? new Error(`IndexedDB ${name} did not open`))
				}
			})

			for (const store of Array.from(database.objectStoreNames)) {
				const entries = await new Promise<unknown[]>((resolve, reject) => {
					const reading = database.transaction(store, "readonly").objectStore(store).getAll()

					reading.onsuccess = () => {
						resolve(reading.result)
					}
					reading.onerror = () => {
						reject(reading.error ?? new Error(`IndexedDB ${name}/${store} did not read`))
					}
				})

				if (entries.some(entry => holds(entry, 0))) {
					found.push(`IndexedDB: ${name}/${store}`)
				}
			}

			database.close()
		}

		for (const key of await window.__filenE2E.kvFindValue(secret)) {
			found.push(`kv: ${key}`)
		}

		return found
	}, password)
}
