/// <reference lib="webworker" />
import * as Comlink from "comlink"
import init, {
	initThreadPool,
	UnauthClient,
	type Client,
	type StringifiedClient,
	type UserInfo,
	type RegisterParams,
	type CompletePasswordResetParams,
	type ChangePasswordParams,
	type Dir,
	type NormalDirsAndFiles,
	type AnyNormalDir
} from "@filen/sdk-rs"
import { run, runEffect, runTimeout } from "@filen/utils"
import { toErrorDTO } from "@/lib/sdk/errors"
import { log } from "@/lib/log"
import { cacheDirs, clearDirectoryCache, getCachedDir, getCachedName } from "@/lib/drive/cache"

// NEITHER a fixed `/` nor `/assets/`: the wasm holds a RELATIVE `./filen-sdk-worker-thread.js`
// (verified via `strings` over sdk-rs_bg.wasm) which it passes to `new Worker(...)`, so the
// async-runtime thread worker resolves against THIS worker's own `self.location` directory —
// observed `/src/workers/` in dev and `/assets/` in the build. The artifact plugin serves the SDK
// files at whatever directory the worker sits in (basename-match in dev; copy to the assets dir in
// the build). Our own wasm `init` URL below is likewise resolved against `self.location`, so it and
// the thread workers share one `sdk-rs_bg.wasm` fetch.
// `opfs` is never returned by this worker's own boot() below — the storage worker lives elsewhere
// (db.worker.ts, orchestrated main-thread by @/lib/sdk/boot's explicit post-boot storage probe) — but
// the reason lives in THIS union so the boot store's `BootReason` (derived from it, kept in lockstep)
// stays the single source of truth for every boot-failure reason the app can hit, wherever it's
// actually detected.
export type BootResult =
	{ ok: true; threads: number } | { ok: false; reason: "artifacts" | "coi" | "pool" | "async-runtime" | "opfs"; detail: string }

let client: Client | null = null

// Every authed op reads the live Client through this guard. Post-logout `client` is null, so a
// forwarded call would null-deref; failing fast here surfaces a clean DTO at the Comlink boundary
// ("no authenticated client") instead of a raw TypeError.
function requireClient(): Client {
	if (client === null) {
		throw new Error("no authenticated client")
	}
	return client
}

// Adopt a freshly-authenticated Client as the live session, freeing the prior handle first (the
// handle law: any op that replaces `client` releases what it replaces). Called only after the new
// handle is in hand, so a failed auth never destroys the existing session. Every path that makes a
// new client live — login, completePasswordReset, injectClient (session resume, e2e re-seed) —
// funnels through here, so clearing the directory cache in this one place, unconditionally,
// guarantees a fresh session never reads a prior account's cached directories/names — including
// the injectClient case, which can adopt a new client without an explicit logout ever running.
function adoptClient(next: Client): void {
	client?.free()
	client = next
	clearDirectoryCache()
}

// Null the live client FIRST so any subsequent authed op fails fast via requireClient() instead of
// racing the teardown, then defer the actual free(): an in-flight wasm call still holds this handle
// and freeing it mid-flight is not verified safe, so hand the free to a later task rather than
// tearing the handle down inside this turn. Shared by logout() and by any op whose adoptClient()
// already succeeded but a later step then failed — a caller-visible failure must never leave the
// worker holding a client the caller believes is dead.
function releaseClient(): void {
	const prev = client
	client = null
	if (prev !== null) {
		setTimeout(() => {
			prev.free()
		}, 0)
	}
}

// Run an unauthenticated op against a throwaway UnauthClient, releasing it (LIFO defer) whichever way
// the op settles; unwraps the Result so the Comlink boundary sees a thrown ErrorDTO, not a Result.
async function withUnauth<T>(fn: (unauth: UnauthClient) => Promise<T>): Promise<T> {
	const r = await run<T>(async defer => {
		const unauth = UnauthClient.from_config({})
		defer(() => {
			unauth.free()
		})
		return fn(unauth)
	})
	if (!r.success) {
		throw r.error
	}
	return r.data
}

async function preflightArtifacts(): Promise<string | null> {
	for (const a of ["filen-sdk-worker-thread.js", "sdk-rs.js", "sdk-rs_bg.wasm"]) {
		try {
			const res = await fetch(new URL(a, self.location.href), { method: "HEAD" })
			if (!res.ok) {
				return `${a}: HTTP ${String(res.status)}`
			}
		} catch (e) {
			return `${a}: ${toErrorDTO(e).label}`
		}
	}
	return null // snippets/** has hashed dirs — covered by the pool timeout below
}

// Named (not inlined) so queries/drive.ts's target-mapping helper can import the exact union
// instead of duplicating it.
export type ListDirectoryTarget = { kind: "root" } | { kind: "uuid"; uuid: string } | { kind: "recents" | "favorites" | "trash" }

const api = {
	async boot({ threads }: { threads: number }): Promise<BootResult> {
		const missing = await preflightArtifacts()
		if (missing !== null) {
			return { ok: false, reason: "artifacts", detail: missing }
		}
		await init({ module_or_path: new URL("sdk-rs_bg.wasm", self.location.href) }) // same base as the runtime spawn — no double download
		if (!self.crossOriginIsolated) {
			return { ok: false, reason: "coi", detail: "crossOriginIsolated=false" }
		}
		// initThreadPool HANGS (not rejects) on a snippets 404 — runTimeout surfaces it as a pool error.
		const pool = await runTimeout(() => initThreadPool(threads), 15_000)
		if (!pool.success) {
			return { ok: false, reason: "pool", detail: toErrorDTO(pool.error).label }
		}
		return { ok: true, threads }
	},
	// Async-runtime health check: an unauth network op that MUST settle (either way).
	async probeAsync(): Promise<void> {
		const r = await runTimeout(async defer => {
			const unauth = UnauthClient.from_config({})
			defer(() => {
				unauth.free()
			}) // defer() releases the wasm handle (LIFO)
			await unauth.startPasswordReset("filen-web-healthcheck-nonexistent@filen.io").catch(() => undefined)
		}, 10_000)
		if (!r.success) {
			throw r.error
		}
	},
	login(params: { email: string; password: string; twoFactorCode?: string }): Promise<StringifiedClient> {
		return withUnauth(async unauth => {
			const next = await unauth.login(params) // LoginParams object (verified .d.ts); 2FA via exception-driven re-call
			adoptClient(next)
			// adoptClient already made `next` the live client; if stringify throws, the caller sees a
			// throw and treats login as failed, so release the client it believes is dead. `await` is
			// load-bearing: a bare `return next.toStringified()` would settle outside this try and escape
			// the catch.
			try {
				return await next.toStringified()
			} catch (e) {
				releaseClient()
				throw e
			}
		})
	},
	register(params: RegisterParams): Promise<void> {
		return withUnauth(unauth => unauth.register(params))
	},
	startPasswordReset(email: string): Promise<void> {
		return withUnauth(unauth => unauth.startPasswordReset(email))
	},
	completePasswordReset(params: CompletePasswordResetParams): Promise<StringifiedClient> {
		// Post-reset auto-login: keep the returned Client live (mirrors login), so the caller lands
		// authed and re-persists the fresh blob.
		return withUnauth(async unauth => {
			const next = await unauth.completePasswordReset(params)
			adoptClient(next)
			// See login: release the just-adopted client if the post-adopt stringify throws, and `await`
			// so the rejection is caught here rather than escaping the try.
			try {
				return await next.toStringified()
			} catch (e) {
				releaseClient()
				throw e
			}
		})
	},
	resendRegistrationConfirmation(email: string): Promise<void> {
		return withUnauth(unauth => unauth.resendRegistrationConfirmation(email))
	},
	injectClient(blob: StringifiedClient): void {
		const r = runEffect(
			defer => {
				const unauth = UnauthClient.from_config({})
				defer(() => {
					unauth.free()
				})
				return unauth.fromStringified(blob) // INSTANCE method (verified .d.ts:1486 + glue) — synchronous, zero network
			},
			{ automaticCleanup: true }
		)
		if (!r.success) {
			throw r.error
		}
		adoptClient(r.data)
	},
	async probeAuthedRead(): Promise<boolean> {
		if (client === null) {
			return false
		}
		const c = client
		// Cheapest authed read (verified .d.ts:1224): a single authenticated round-trip returning plain
		// UserInfo — no wasm handle to free (unlike listDir(root()), which allocates a Root). Proves the
		// injected session actually authenticates against the API.
		const r = await runTimeout(() => c.getUserInfo(), 15_000)
		if (!r.success) {
			throw r.error
		}
		return true
	},
	getUserInfo(): Promise<UserInfo> {
		// bigint fields (ids, storage/quota counters) cross Comlink via structured clone — no boundary
		// serializer.
		return requireClient().getUserInfo()
	},
	// Re-stringifies whatever client is CURRENTLY live, independent of any particular auth flow — same
	// shape as getUserInfo: a plain authed read, no mutation. Today's only caller is the E2E harness's
	// dumpSession hook, which needs the just-authenticated client regardless of whether persistSession's
	// own kv write happened to succeed.
	toStringified(): Promise<StringifiedClient> {
		return requireClient().toStringified()
	},
	async changePassword(params: ChangePasswordParams): Promise<StringifiedClient> {
		const c = requireClient()
		await c.changePassword(params) // mutates the live client in place (re-derives keys)
		// Re-stringify AFTER the mutation so the caller re-persists the new credential fingerprint; the
		// pre-change blob would no longer authenticate.
		return c.toStringified()
	},
	exportMasterKeys(): Promise<string> {
		return requireClient().exportMasterKeys()
	},
	enable2FA(code: string): Promise<string> {
		// Returns the 2FA backup code — the only artifact this app names a "recovery key".
		return requireClient().enable2FAGetRecoveryKey(code)
	},
	async disable2FA(code: string): Promise<void> {
		await requireClient().disable2FA(code)
	},
	async deleteAccount(code?: string): Promise<void> {
		await requireClient().deleteAccount(code)
	},
	// `listDir`/`getDirOptional`/`createDir` take no cancellation param (unlike mobile's transfer
	// facade) — a stale response from a fast navigation is simply discarded once the query key
	// changes under it, so no AbortSignal plumbing is needed here. `Dir.timestamp`/meta bigints
	// cross Comlink via structured clone, same as getUserInfo — no boundary serializer.
	async listDirectory(target: ListDirectoryTarget): Promise<NormalDirsAndFiles> {
		const c = requireClient()
		const result = await (async (): Promise<NormalDirsAndFiles> => {
			switch (target.kind) {
				case "root":
					return c.listDir(c.root())
				case "recents":
					return c.listRecents()
				case "favorites":
					return c.listFavorites()
				case "trash":
					return c.listTrash()
				case "uuid": {
					// Cache-first: a directory just listed as part of its own parent's listing is
					// already held here, so browsing into it costs zero extra round trips.
					// getDirOptional (not listDir({uuid})) is the cold-miss fallback — a plain
					// `{uuid}` object is structurally a Root, and a bare string isn't assignable to
					// the branded UuidStr AnyNormalDir needs.
					const dir = getCachedDir(target.uuid) ?? (await c.getDirOptional(target.uuid))
					if (dir === undefined) {
						throw new Error(`directory not found: ${target.uuid}`)
					}
					return c.listDir(dir)
				}
			}
		})()
		// Every returned dir becomes resolvable by uuid for the rest of this session — the next
		// listing into one of them, or a breadcrumb resolving its name, never needs its own round
		// trip. Populated uniformly across every branch (recents/favorites/trash can surface
		// directories too — a favorited or trashed directory browsed into later hits this cache
		// exactly like one reached from a normal listing).
		cacheDirs(result.dirs)
		return result
	},
	// Backend directory create is idempotent and case-insensitive: an existing directory with this
	// name under this parent returns ITS uuid rather than erroring (a name clash with a FILE still
	// rejects) — so no pre-check call. `dirExists` always resolved void regardless of outcome and
	// could never actually signal "already exists"; the pre-check bought nothing but a wasted round
	// trip.
	async createDirectory(parentUuid: string | null, name: string): Promise<Dir> {
		const c = requireClient()
		const parent: AnyNormalDir = await (async (): Promise<AnyNormalDir> => {
			if (parentUuid === null) {
				return c.root()
			}
			// Cache-first parent resolve, same rule as listDirectory's uuid case.
			const found = getCachedDir(parentUuid) ?? (await c.getDirOptional(parentUuid))
			if (found === undefined) {
				throw new Error(`parent directory not found: ${parentUuid}`)
			}
			return found
		})()
		const created = await c.createDir(parent, name)
		cacheDirs([created])
		return created
	},
	// Thin getDirOptional pass-through.
	getDirectory(uuid: string): Promise<Dir | undefined> {
		return requireClient().getDirOptional(uuid)
	},
	// Breadcrumb primitive: the "/drive/$" splat carries the full ancestor-uuid path in the URL
	// already (see lib/drive/navigate.ts), so this only resolves DISPLAY NAMES for a batch of
	// uuids — no getItemPath walk. Cache-first per uuid; only a cold miss (e.g. a deep-linked path
	// this tab has never listed before) calls getDirOptional, and every miss resolves IN PARALLEL —
	// a cold multi-segment link costs one round trip per uncached segment, not one per depth level
	// in series. A uuid that never resolves (not found, or a rejected lookup) is simply absent from
	// the returned record; the caller falls back to displaying the raw uuid for that segment.
	async resolveDirectoryNames(uuids: string[]): Promise<Record<string, string>> {
		const c = requireClient()
		const misses = uuids.filter(uuid => getCachedName(uuid) === undefined)

		await Promise.all(
			misses.map(async uuid => {
				const dir = await c.getDirOptional(uuid).catch((e: unknown) => {
					log.warn("sdk.worker", "resolveDirectoryNames: unresolved uuid", uuid, e)
					return undefined
				})
				if (dir !== undefined) {
					cacheDirs([dir])
				}
			})
		)

		const names: Record<string, string> = {}
		for (const uuid of uuids) {
			const name = getCachedName(uuid)
			if (name !== undefined) {
				names[uuid] = name
			}
		}
		return names
	},
	logout(): void {
		releaseClient()
	},
	hasClient(): boolean {
		return client !== null
	}
}
export type SdkWorkerApi = typeof api

// DTO-at-the-boundary: FilenSdkError clones hollow; Comlink re-throws plain thrown objects intact.
Comlink.expose(
	new Proxy(api, {
		get(t, p, r) {
			const v = Reflect.get(t, p, r) as unknown
			if (typeof v !== "function") {
				return v
			}
			return async (...args: unknown[]) => {
				try {
					return await (v as (...a: unknown[]) => unknown).apply(t, args)
				} catch (e) {
					log.error("sdk.worker", e)
					// eslint-disable-next-line @typescript-eslint/only-throw-error -- deliberate: Comlink structured-clones a plain thrown object intact; an Error subclass would lose the DTO's custom fields to Comlink's lossy Error serializer.
					throw toErrorDTO(e)
				}
			}
		}
	})
)
