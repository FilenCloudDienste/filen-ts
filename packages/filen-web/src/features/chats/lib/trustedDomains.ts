import { type, type Type } from "arktype"
import { kvGetJson, kvSetJson } from "@/lib/storage/adapter"

// One-time-per-domain memory for the chat message external-link trust confirmation — a domain the user
// has already confirmed opening once stays trusted for every future link to it, in every chat, across
// reloads.
const TRUSTED_DOMAINS_KV_KEY = "chats.trustedLinkDomains.v1"

const trustedDomainsSchema: Type<string[]> = type("string[]")

export async function getTrustedDomains(): Promise<ReadonlySet<string>> {
	const stored = await kvGetJson(TRUSTED_DOMAINS_KV_KEY, trustedDomainsSchema)

	return new Set(stored ?? [])
}

// Idempotent — trusting an already-trusted domain twice is a no-op write (the Set collapses the dup
// before it's ever persisted).
export async function trustDomain(domain: string): Promise<void> {
	const current = await getTrustedDomains()

	await kvSetJson(TRUSTED_DOMAINS_KV_KEY, [...current, domain])
}
