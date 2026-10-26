import { type, type Type } from "arktype"

// What the sync and mounts bridges share on main's side: the pages they push to and their checked IPC calls.

// A page (one web contents) as main reaches it.
export interface Page {
	id: number
	send(channel: string, payload: unknown): void
}

// The part of an Electron IPC event the handlers read.
export interface IpcEvent {
	senderFrame: { url: string } | null
	sender: { id: number; send(channel: string, ...args: unknown[]): void; isDestroyed(): boolean }
}

export interface IpcMain {
	handle(channel: string, listener: (event: IpcEvent, ...args: unknown[]) => unknown): void
	on(channel: string, listener: (event: IpcEvent, ...args: unknown[]) => void): unknown
}

export function pageOf(sender: IpcEvent["sender"]): Page {
	return {
		id: sender.id,
		send: (channel, payload) => {
			if (!sender.isDestroyed()) {
				sender.send(channel, payload)
			}
		}
	}
}

export type CheckedCall<Service> = (service: Service, page: Page, args: unknown[]) => unknown

// A call whose arguments are checked as a whole tuple, so an extra one fails too; `what` names the bridge in the error.
export function checkedCalls<Service>(what: string) {
	return <S extends Type<readonly unknown[]>>(
			schema: S,
			run: (service: Service, page: Page, args: S["inferOut"]) => unknown
		): CheckedCall<Service> =>
		(service, page, args) => {
			const valid: S["inferOut"] | type.errors = schema(args)

			if (valid instanceof type.errors) {
				throw new Error(`invalid ${what} payload`)
			}

			return run(service, page, valid)
		}
}

// Every call answers the app's own top-level document only, with its arguments checked before the service sees them.
export function registerCalls<Name extends string, Service>(
	ipc: IpcMain,
	calls: Record<Name, CheckedCall<Service>>,
	channel: (name: Name) => string,
	service: Service,
	trusted: (senderUrl: string | undefined) => boolean
): void {
	for (const [name, run] of Object.entries(calls) as [Name, CheckedCall<Service>][]) {
		ipc.handle(channel(name), (event, ...args) => {
			if (!trusted(event.senderFrame?.url)) {
				throw new Error("untrusted sender")
			}

			return run(service, pageOf(event.sender), args)
		})
	}
}

// Runs `push` at most once per `intervalMs`, after the change that asked for it; nothing runs while no page listens.
export function pushThrottle(push: () => void, intervalMs: number, now: () => number, listening: () => boolean): () => void {
	let timer: NodeJS.Timeout | undefined
	let last = Number.NEGATIVE_INFINITY

	return () => {
		if (!listening() || timer !== undefined) {
			return
		}

		timer = setTimeout(
			() => {
				timer = undefined
				last = now()
				push()
			},
			Math.max(0, last + intervalMs - now())
		)
	}
}
