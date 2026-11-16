// Filen's domains: filen.io and the SDK's failover domains, filen.net and filen-1.net … filen-6.net.
export const FILEN_DOMAINS = [
	"filen.io",
	"filen.net",
	"filen-1.net",
	"filen-2.net",
	"filen-3.net",
	"filen-4.net",
	"filen-5.net",
	"filen-6.net"
] as const

// One Filen host family: its .filen.io host plus the failovers.
export function filenHostFamily(subdomain: string): string[] {
	return FILEN_DOMAINS.map(domain => `https://${subdomain}.${domain}`)
}
