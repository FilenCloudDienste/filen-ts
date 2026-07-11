import { type, type Type } from "arktype"
import { storageRole, onStorageLeadershipChange } from "@/lib/storage/leader"
import { storage } from "@/lib/storage/adapter"
import { parseEnvelope, stringifyEnvelope } from "@/lib/serialize"
import { log } from "@/lib/log"
import { sync, type OutboxTransport } from "@/features/notes/lib/sync"
import { inflightContentSchema, type RemoteEnqueue } from "@/features/notes/lib/sync.logic"

// ADAPTATION B1 wiring: binds the leader-owned notes outbox (sync.ts) to a dedicated cross-tab
// BroadcastChannel and to the db-lock leadership signal (leader.ts). This channel is SEPARATE from the
// db RPC channel — it never touches the db worker protocol. The leader tab (whoever holds the db lock)
// runs the push loop; followers forward edits here and mirror the leader's state broadcasts.

const OUTBOX_CHANNEL = "filen-web-notes-outbox"

// follower → leader: forward one edit / request a flush / request current state.
// leader → followers: authoritative state + a takeover announcement.
type OutboxMsg =
	| { kind: "enqueue"; payload: string } // envelope-encoded RemoteEnqueue (Note carries bigint)
	| { kind: "executeNow" }
	| { kind: "stateRequest" }
	| { kind: "state"; payload: string } // envelope-encoded InflightContent
	| { kind: "leaderHello" }

// A follower's forwarded edit, validated at the trust boundary the same way the durable outbox
// validates its persisted entries: `note` as a non-null object only (over-constraining the wasm Note
// snapshot would drop otherwise-valid forwards the moment the SDK adds a field; the leader prefers the
// live note from its own list cache anyway).
const remoteEnqueueSchema = type({
	note: "object",
	content: "string",
	timestamp: "number",
	"baseContentHash?": "string"
}).as<RemoteEnqueue>()

let started = false

function makeTransport(channel: BroadcastChannel): OutboxTransport {
	const post = (msg: OutboxMsg): void => {
		channel.postMessage(msg)
	}

	return {
		sendEnqueue: msg => {
			post({ kind: "enqueue", payload: stringifyEnvelope(msg) })
		},
		sendExecuteNow: () => {
			post({ kind: "executeNow" })
		},
		requestState: () => {
			post({ kind: "stateRequest" })
		},
		broadcastState: state => {
			post({ kind: "state", payload: stringifyEnvelope(state) })
		},
		broadcastLeaderHello: () => {
			post({ kind: "leaderHello" })
		}
	}
}

// Decode + validate an envelope-encoded payload; a corrupt message is dropped (never thrown up into the
// channel callback), same convention as the kv read path.
function decode<T>(payload: string, schema: Type<T>, context: string): T | null {
	let parsed: unknown

	try {
		parsed = parseEnvelope(payload)
	} catch {
		log.warn("notes-outbox", `dropping unparseable ${context}`)

		return null
	}

	const out = schema(parsed)

	if (out instanceof type.errors) {
		log.warn("notes-outbox", `dropping invalid ${context}`, out.summary)

		return null
	}

	return out as T
}

// One dispatcher, routed by the outbox's CURRENT role (role flips live on promotion): the leader half
// handles follower forwards, the follower half handles leader broadcasts. A message meant for the other
// role is ignored — a tab never acts on its own category.
function handleMessage(msg: OutboxMsg): void {
	if (sync.outboxRole === "leader") {
		switch (msg.kind) {
			case "enqueue": {
				const decoded = decode(msg.payload, remoteEnqueueSchema, "forwarded edit")

				if (decoded !== null) {
					sync.ingestRemoteEnqueue(decoded)
				}

				return
			}
			case "executeNow": {
				sync.executeNow()

				return
			}
			case "stateRequest": {
				sync.broadcastState()

				return
			}
			default:
				return
		}
	}

	switch (msg.kind) {
		case "state": {
			const decoded = decode(msg.payload, inflightContentSchema, "leader state")

			if (decoded !== null) {
				sync.applyLeaderState(decoded)
			}

			return
		}
		case "leaderHello": {
			sync.resendUnacked()

			return
		}
		default:
			return
	}
}

// Mounted once by SyncHost. Attaches the transport, then adopts the initial role from the db lock and
// subscribes to promotion. Idempotent (StrictMode double-mount): a second call is a no-op.
export async function startOutbox(): Promise<void> {
	if (started) {
		return
	}

	started = true

	const channel = new BroadcastChannel(OUTBOX_CHANNEL)

	sync.attachTransport(makeTransport(channel))
	channel.onmessage = (ev: MessageEvent<OutboxMsg>) => {
		handleMessage(ev.data)
	}

	// A follower that wins the db lock after the leader dies must hand itself the loop. Guard on the
	// outbox's own role so a redundant signal (or the initial leader's setRole) never double-promotes.
	const promoteIfNeeded = (): void => {
		if (storageRole() === "leader" && sync.outboxRole === "follower") {
			sync.promoteToLeader()
		}
	}

	onStorageLeadershipChange(promoteIfNeeded)

	const { role } = await storage()

	if (role === "leader") {
		sync.start()
	} else {
		sync.startAsFollower()
	}

	// Close the race between `await storage()` resolving as follower and the subscription above: a
	// promotion that landed in that gap fired with no follower role yet set, so re-check once now.
	promoteIfNeeded()
}
