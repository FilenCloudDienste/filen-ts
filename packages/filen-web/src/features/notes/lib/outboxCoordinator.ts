import { type } from "arktype"
import { type OutboxChannelMsg, makeOutboxChannelTransport, decodeOutboxPayload, bindOutboxLeadership } from "@/lib/storage/outboxChannel"
import { sync } from "@/features/notes/lib/sync"
import { inflightContentSchema, type RemoteEnqueue } from "@/features/notes/lib/sync.logic"
import { type InflightContent } from "@/features/notes/store/useNotesInflight"

// Binds the leader-owned notes outbox (sync.ts) to a dedicated cross-tab channel + the db-lock leadership
// signal, via the shared coordinator core (outboxChannel.ts). The leader tab (whoever holds the db lock) runs
// the push loop; followers forward edits here and mirror the leader's state broadcasts. This channel is
// SEPARATE from the db RPC channel — it never touches the db worker protocol.

const OUTBOX_CHANNEL = "filen-web-notes-outbox"

// A follower's forwarded edit, validated at the trust boundary the same way the durable outbox validates its
// persisted entries: `note` as a non-null object only (over-constraining the wasm Note snapshot would drop
// otherwise-valid forwards the moment the SDK adds a field; the leader prefers the live note from its own
// list cache anyway).
const remoteEnqueueSchema = type({
	note: "object",
	content: "string",
	timestamp: "number",
	"baseContentHash?": "string"
}).as<RemoteEnqueue>()

let started = false

// One dispatcher, routed by the outbox's CURRENT role (role flips live on promotion): the leader half handles
// follower forwards, the follower half handles leader broadcasts. A message meant for the other role is
// ignored — a tab never acts on its own category.
function handleMessage(msg: OutboxChannelMsg): void {
	if (sync.outboxRole === "leader") {
		switch (msg.kind) {
			case "enqueue": {
				const decoded = decodeOutboxPayload(msg.payload, remoteEnqueueSchema, "forwarded edit")

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
			const decoded = decodeOutboxPayload(msg.payload, inflightContentSchema, "leader state")

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

	await bindOutboxLeadership(OUTBOX_CHANNEL, sync, channel => {
		sync.attachTransport(makeOutboxChannelTransport<RemoteEnqueue, InflightContent>(channel))
		channel.onmessage = (ev: MessageEvent<OutboxChannelMsg>) => {
			handleMessage(ev.data)
		}
	})
}
