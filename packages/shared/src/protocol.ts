import { z } from "zod";
import { StatusSnapshot } from "./domain";

/*
 * Wire protocol between UI clients, the cloud hub and Office Hosts.
 * The hub routes `relay` / `reply` payloads without looking inside them.
 */

export const MAX_MESSAGE_BYTES = 256 * 1024;

/** What a host signs to prove it owns an office. */
export const hostAuthMessage = (nonce: string, officeId: string): string => `agent-office-hub-auth|${nonce}|${officeId}`;

// host -> hub
export const HostToHub = z.discriminatedUnion("type", [
  z.object({ type: z.literal("host.enroll"), enrollToken: z.string().min(10).max(200), hostPublicKey: z.string().min(40).max(60) }),
  z.object({ type: z.literal("host.auth"), officeId: z.string().min(1).max(100), signature: z.string().min(1).max(200) }),
  z.object({ type: z.literal("status"), status: StatusSnapshot }),
  z.object({ type: z.literal("reply"), to: z.string().min(1).max(100), payload: z.unknown() }),
  z.object({ type: z.literal("event"), payload: z.unknown() }),
]);
export type HostToHub = z.infer<typeof HostToHub>;

// hub -> host
export const HubToHost = z.discriminatedUnion("type", [
  z.object({ type: z.literal("challenge"), nonce: z.string() }),
  z.object({ type: z.literal("enrolled"), officeId: z.string() }),
  z.object({ type: z.literal("authed") }),
  z.object({ type: z.literal("relay"), from: z.string(), payload: z.unknown() }),
  z.object({ type: z.literal("error"), code: z.string() }),
]);
export type HubToHost = z.infer<typeof HubToHost>;

// client -> hub
export const ClientToHub = z.discriminatedUnion("type", [
  /** Must be the first message on a client connection. The token is never put in the URL, where logs would keep it. */
  z.object({ type: z.literal("auth"), token: z.string().min(1).max(500) }),
  z.object({ type: z.literal("subscribe"), officeId: z.string().min(1).max(100) }),
  z.object({ type: z.literal("relay"), officeId: z.string().min(1).max(100), payload: z.unknown() }),
]);
export type ClientToHub = z.infer<typeof ClientToHub>;

// hub -> client
export const HubToClient = z.discriminatedUnion("type", [
  z.object({ type: z.literal("hello"), clientId: z.string() }),
  z.object({
    type: z.literal("office.status"),
    officeId: z.string(),
    online: z.boolean(),
    lastSeen: z.number().nullable(),
    status: StatusSnapshot.nullable(),
  }),
  z.object({ type: z.literal("reply"), officeId: z.string(), payload: z.unknown() }),
  z.object({ type: z.literal("event"), officeId: z.string(), payload: z.unknown() }),
  z.object({ type: z.literal("error"), code: z.string(), officeId: z.string().optional() }),
]);
export type HubToClient = z.infer<typeof HubToClient>;

/** Host reply to a signed command. Signed by the host so the relay cannot edit it. */
export interface CommandReplyBody {
  type: "command.reply";
  nonce: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}
