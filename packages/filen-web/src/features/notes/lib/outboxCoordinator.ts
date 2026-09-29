import { type } from "arktype"
import {
	type OutboxChannelMsg,
	type OutboxRoute,
	makeOutboxChannelTransport,
	routeOutboxMessage,
	bindOutboxLeadership
} from "@/lib/storage/outboxChannel"
import { sync } from "@/features/notes/lib/sync"
import { inflightContentSchema, type RemoteEnqueue } from "@/features/notes/lib/sync.logic"
import { setOutboxHydrated, type InflightContent } from "@/features/notes/store/useNotesInflight"
import { rememberNotePush, setNotePushBroadcast } from "@/features/notes/lib/pushEchoes"
import { setNoteAnswerBroadcast, useNotesRemoteEditStore } from "@/features/notes/store/useNoteRemoteEdit"

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
	"baseContentHash?": "string",
	"origin?": "string",
	"carriedFrom?": "string",
	"answer?": "true"
}).as<RemoteEnqueue>()

const ROUTE: OutboxRoute<RemoteEnqueue, InflightContent> = {
	enqueueSchema: remoteEnqueueSchema,
	stateSchema: inflightContentSchema,
	enqueueLabel: "forwarded edit",
	stateLabel: "leader state"
}

let started = false

// Backstop for the editor's hydration gate (useNoteEditor): every normal path flips it within a disk
// read or a same-machine broadcast, but leadership resolution, that disk read and a peer leader are all
// things that can hang. The editor must degrade to the un-gated behavior instead of spinning forever,
// so the gate opens on its own well after any healthy boot has already opened it.
const HYDRATION_BACKSTOP_MS = 5000

// The notes-only kinds first, then the shared role-routed dispatch.
function handleMessage(msg: OutboxChannelMsg): void {
	// Every tab keeps the list of what the leader pushed, whichever role it holds by the time it hears.
	if (msg.kind === "pushed") {
		if (msg.landed === true) {
			sync.heardLanded(msg.id, msg.hash, msg)
		} else {
			rememberNotePush(msg.id, msg.hash)
			sync.heardPush(msg.id, msg.hash, msg)
		}

		return
	}

	// Answered in another tab: this one stops asking, and stops holding the note's pushes (unless its own
	// typing is still unsaved, see dropRemoteEdited).
	if (msg.kind === "answered") {
		useNotesRemoteEditStore.getState().dropRemoteEdited(msg.id, msg.choice)

		return
	}

	// Leader-only: ingestDrop no-ops on any other role.
	if (msg.kind === "drop") {
		sync.ingestDrop(msg.id)

		return
	}

	routeOutboxMessage(msg, sync, ROUTE)
}

// Mounted once by SyncHost. Attaches the transport, then adopts the initial role from the db lock and
// subscribes to promotion. Idempotent (StrictMode double-mount): a second call is a no-op.
export async function startOutbox(): Promise<void> {
	if (started) {
		return
	}

	started = true

	setTimeout(() => {
		setOutboxHydrated(true)
	}, HYDRATION_BACKSTOP_MS)

	await bindOutboxLeadership(OUTBOX_CHANNEL, sync, channel => {
		const transport = makeOutboxChannelTransport<RemoteEnqueue, InflightContent>(channel)

		sync.attachTransport(transport)
		setNotePushBroadcast(transport.broadcastPushed)
		setNoteAnswerBroadcast(transport.broadcastAnswered)
		channel.onmessage = (ev: MessageEvent<OutboxChannelMsg>) => {
			handleMessage(ev.data)
		}
	})
}
