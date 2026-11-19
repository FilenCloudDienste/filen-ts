import { type, type Type } from "arktype"
import { kvGetJson, kvSetJson } from "@/lib/storage/adapter"

// One-time-per-domain memory for the external-link trust confirmation: a domain confirmed once stays
// trusted for every later link to it (chats, documents, markdown, PDF), across reloads. The key predates
// the documents using it and stays, so trust already given carries over.
const TRUSTED_DOMAINS_KV_KEY = "chats.trustedLinkDomains.v1"

const trustedDomainsSchema: Type<string[]> = type("string[]")

export async function getTrustedDomains(): Promise<ReadonlySet<string>> {
	const stored = await kvGetJson(TRUSTED_DOMAINS_KV_KEY, trustedDomainsSchema)

	return new Set(stored ?? [])
}

// Idempotent: trusting an already-trusted domain writes nothing.
export async function trustDomain(domain: string): Promise<void> {
	const current = await getTrustedDomains()

	if (current.has(domain)) {
		return
	}

	await kvSetJson(TRUSTED_DOMAINS_KV_KEY, [...current, domain])
}
