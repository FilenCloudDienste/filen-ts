import { createServer, type IncomingMessage } from "node:http"
import { type AddressInfo, connect, type Socket } from "node:net"

// A CONNECT proxy on the loopback interface for the proxy-only and connection-fault checks (chains/proxyCheck.ts). It
// only relays: each tunnel is a TCP stream to the host:port the client named, TLS stays end to end (nothing is
// intercepted or decrypted), so what it sees is a host, a port and byte counts. Every tunnel is logged by host:port.
// Faults are armed while it runs: a reset after so many bytes, every tunnel to a host reset, the first reply bytes held,
// a throttle. Plain HTTP requests are refused (405): the clients under test speak HTTPS only.

export interface Tunnel {
	id: number
	host: string
	port: number
	openedAt: number
	// Bytes relayed client -> server and server -> client.
	up: number
	down: number
	closedAt: number | null
	// Why it closed: "closed", "error: ...", or the fault that reset it.
	end: string | null
}

export type Direction = "up" | "down"

export type Fault =
	// The first `tunnels` tunnels to `host` that relay `bytes` in `direction` after arming are reset there.
	| { kind: "resetAfter"; host: string; direction: Direction; bytes: number; tunnels: number }
	// Every tunnel to `host`, open or new, is reset while armed (a new one at its first byte).
	| { kind: "resetAll"; host: string }
	// The first reply bytes any tunnel to `host` gets after arming are held `ms`, then relayed.
	| { kind: "holdFirstReply"; host: string; ms: number }
	// Every tunnel together, each direction, at most `bytesPerSecond`.
	| { kind: "throttle"; bytesPerSecond: number }

export interface ArmedFault {
	readonly fault: Fault
	// How often it acted: resets, holds, throttled chunks.
	readonly fired: number
	// The throttle's and the hold's total delay, in ms.
	readonly delayedMs: number
	disarm(): void
}

export interface ConnectProxy {
	// http://127.0.0.1:<port>, for HTTPS_PROXY and --proxy-server.
	readonly url: string
	readonly port: number
	tunnels(): readonly Tunnel[]
	// Every distinct host:port a tunnel was asked for, sorted.
	hosts(): string[]
	arm(fault: Fault): ArmedFault
	disarmAll(): void
	close(): Promise<void>
}

interface Armed extends ArmedFault {
	fired: number
	delayedMs: number
	active: boolean
	// resetAfter: bytes per tunnel since arming; holdFirstReply: whether a hold has started.
	counted: Map<number, number>
	held: boolean
}

interface Live {
	tunnel: Tunnel
	client: Socket
	server: Socket
	// Per direction, why the reading side is paused (backpressure, the throttle, a hold); it resumes once none is left.
	paused: Record<Direction, Set<string>>
	// Reply bytes held back by a hold, relayed in order once it ends.
	holding: Buffer[] | null
}

// "host:port" or "[v6]:port" of a CONNECT request line; null for anything else.
export function parseAuthority(authority: string): { host: string; port: number } | null {
	const match = /^(?:\[([^\]]+)\]|([^:[\]]+)):(\d{1,5})$/.exec(authority)
	const host = match?.[1] ?? match?.[2]
	const port = Number(match?.[3])

	return host === undefined || !Number.isInteger(port) || port < 1 || port > 65_535 ? null : { host: host.toLowerCase(), port }
}

export async function startConnectProxy(log: (line: string) => void = line => console.log(line)): Promise<ConnectProxy> {
	const tunnels: Tunnel[] = []
	const live = new Map<number, Live>()
	let armed: Armed[] = []
	// The throttle's next free moment per direction, shared by every tunnel.
	const nextFree: Record<Direction, number> = { up: 0, down: 0 }
	let nextId = 1

	const pause = (entry: Live, direction: Direction, reason: string) => {
		entry.paused[direction].add(reason)
		;(direction === "up" ? entry.client : entry.server).pause()
	}
	const release = (entry: Live, direction: Direction, reason: string) => {
		entry.paused[direction].delete(reason)

		if (entry.paused[direction].size === 0) {
			;(direction === "up" ? entry.client : entry.server).resume()
		}
	}

	const reset = (entry: Live, why: string) => {
		if (entry.tunnel.end === null) {
			entry.tunnel.end = why
		}

		entry.client.resetAndDestroy()
		entry.server.resetAndDestroy()
	}

	const write = (entry: Live, direction: Direction, chunk: Buffer) => {
		const destination = direction === "up" ? entry.server : entry.client

		entry.tunnel[direction] += chunk.length

		if (!destination.write(chunk)) {
			pause(entry, direction, "drain")
			destination.once("drain", () => release(entry, direction, "drain"))
		}
	}

	// A chunk read from one side, through the armed faults, to the other.
	const relay = (entry: Live, direction: Direction, chunk: Buffer) => {
		if (entry.holding !== null && direction === "down") {
			entry.holding.push(chunk)

			return
		}

		for (const fault of armed) {
			const spec = fault.fault

			if (!fault.active || (spec.kind !== "throttle" && spec.host !== entry.tunnel.host)) {
				continue
			}

			if (spec.kind === "resetAll") {
				fault.fired++
				reset(entry, "reset (resetAll)")

				return
			}

			if (spec.kind === "resetAfter" && spec.direction === direction && fault.fired < spec.tunnels) {
				const counted = (fault.counted.get(entry.tunnel.id) ?? 0) + chunk.length

				fault.counted.set(entry.tunnel.id, counted)

				if (counted >= spec.bytes) {
					fault.fired++
					reset(entry, `reset after ${String(counted)} bytes ${direction} (resetAfter)`)

					return
				}
			}

			if (spec.kind === "holdFirstReply" && direction === "down" && !fault.held) {
				fault.held = true
				fault.fired++
				fault.delayedMs += spec.ms
				entry.holding = [chunk]
				pause(entry, "down", "hold")
				setTimeout(() => {
					const held = entry.holding ?? []

					entry.holding = null

					if (entry.tunnel.end === null) {
						for (const part of held) {
							write(entry, "down", part)
						}

						release(entry, "down", "hold")
					}
				}, spec.ms).unref()

				return
			}
		}

		write(entry, direction, chunk)

		const throttle = armed.find(fault => fault.active && fault.fault.kind === "throttle")

		if (throttle !== undefined && throttle.fault.kind === "throttle") {
			const now = Date.now()
			const start = Math.max(now, nextFree[direction])

			nextFree[direction] = start + (chunk.length * 1000) / throttle.fault.bytesPerSecond

			const wait = Math.round(nextFree[direction] - now)

			if (wait > 0) {
				throttle.fired++
				throttle.delayedMs += wait
				pause(entry, direction, "throttle")
				setTimeout(() => release(entry, direction, "throttle"), wait).unref()
			}
		}
	}

	const server = createServer((_request, response) => {
		response.writeHead(405, { Connection: "close" }).end()
	})

	server.on("connect", (request: IncomingMessage, client: Socket, head: Buffer) => {
		const target = parseAuthority(request.url ?? "")

		if (target === null) {
			client.end("HTTP/1.1 400 Bad Request\r\n\r\n")

			return
		}

		const tunnel: Tunnel = {
			id: nextId++,
			host: target.host,
			port: target.port,
			openedAt: Date.now(),
			up: 0,
			down: 0,
			closedAt: null,
			end: null
		}
		const upstream = connect({ host: target.host, port: target.port })
		const entry: Live = { tunnel, client, server: upstream, paused: { up: new Set(), down: new Set() }, holding: null }

		tunnels.push(tunnel)
		live.set(tunnel.id, entry)
		log(`proxy: tunnel ${String(tunnel.id)} ${target.host}:${String(target.port)}`)

		let finished = false
		const finish = (why: string) => {
			if (finished) {
				return
			}

			finished = true
			tunnel.end ??= why
			tunnel.closedAt = Date.now()
			live.delete(tunnel.id)
			client.destroy()
			upstream.destroy()
			log(
				`proxy: tunnel ${String(tunnel.id)} ${target.host}:${String(target.port)} ended (${tunnel.end}; up ${String(tunnel.up)}, down ${String(tunnel.down)})`
			)
		}

		// Paused until the upstream connection stands.
		client.pause()
		client.on("error", error => finish(`error: client ${error.message}`))
		upstream.on("error", error => {
			if (upstream.connecting) {
				client.end("HTTP/1.1 502 Bad Gateway\r\n\r\n")
			}

			finish(`error: upstream ${error.message}`)
		})
		client.on("close", () => finish("closed"))
		upstream.on("close", () => finish("closed"))
		upstream.once("connect", () => {
			client.write("HTTP/1.1 200 Connection Established\r\n\r\n")
			client.on("data", (chunk: Buffer) => relay(entry, "up", chunk))
			upstream.on("data", (chunk: Buffer) => relay(entry, "down", chunk))
			client.on("end", () => upstream.end())
			upstream.on("end", () => client.end())

			if (head.length > 0) {
				relay(entry, "up", head)
			}

			if (entry.paused.up.size === 0) {
				client.resume()
			}
		})
	})

	await new Promise<void>((resolve, reject) => {
		server.once("error", reject)
		server.listen(0, "127.0.0.1", resolve)
	})

	const { port } = server.address() as AddressInfo

	return {
		url: `http://127.0.0.1:${String(port)}`,
		port,
		tunnels: () => tunnels,
		hosts: () => [...new Set(tunnels.map(tunnel => `${tunnel.host}:${String(tunnel.port)}`))].sort(),
		arm(fault) {
			const entry: Armed = {
				fault,
				fired: 0,
				delayedMs: 0,
				active: true,
				counted: new Map(),
				held: false,
				disarm() {
					entry.active = false
					armed = armed.filter(other => other !== entry)
				}
			}

			armed = [...armed, entry]

			// An open tunnel to the host goes at once.
			if (fault.kind === "resetAll") {
				for (const open of [...live.values()].filter(candidate => candidate.tunnel.host === fault.host)) {
					entry.fired++
					reset(open, "reset (resetAll)")
				}
			}

			return entry
		},
		disarmAll() {
			for (const fault of [...armed]) {
				fault.disarm()
			}
		},
		close: () =>
			new Promise<void>(resolve => {
				for (const open of live.values()) {
					open.client.destroy()
					open.server.destroy()
				}

				server.closeAllConnections()
				server.close(() => resolve())
			})
	}
}
