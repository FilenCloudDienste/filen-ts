import {
	type OutboxChannelMsg,
	type OutboxRoute,
	makeOutboxChannelTransport,
	routeOutboxMessage,
	bindOutboxLeadership
} from "@/lib/storage/outboxChannel"
import { sync } from "@/features/chats/lib/sync"
import { inflightChatMessagesSchema, remoteChatEnqueueSchema, type RemoteChatEnqueue } from "@/features/chats/lib/sync.logic"
import { type InflightChatMessages } from "@/features/chats/store/useChatsInflight"

// Binds the leader-owned chat send outbox (sync.ts) to a dedicated cross-tab channel + the db-lock leadership
// signal, via the shared coordinator core (outboxChannel.ts) — the SAME leadership the notes outbox rides, no
// second election. The leader tab (whoever holds the db lock) runs the sequential push loop; followers forward
// sends here and mirror the leader's queue broadcasts. This channel is SEPARATE from the db RPC channel — it
// never touches the db worker protocol.

const OUTBOX_CHANNEL = "filen-web-chats-outbox"

const ROUTE: OutboxRoute<RemoteChatEnqueue, InflightChatMessages> = {
	enqueueSchema: remoteChatEnqueueSchema,
	stateSchema: inflightChatMessagesSchema,
	enqueueLabel: "forwarded send",
	stateLabel: "leader state"
}

let started = false

// Mounted once by ChatsSyncHost. Attaches the transport, then adopts the initial role from the db lock and
// subscribes to promotion. Idempotent (StrictMode double-mount): a second call is a no-op.
export async function startChatOutbox(): Promise<void> {
	if (started) {
		return
	}

	started = true

	await bindOutboxLeadership(OUTBOX_CHANNEL, sync, channel => {
		sync.attachTransport(makeOutboxChannelTransport<RemoteChatEnqueue, InflightChatMessages>(channel))
		channel.onmessage = (ev: MessageEvent<OutboxChannelMsg>) => {
			routeOutboxMessage(ev.data, sync, ROUTE)
		}
	})
}
