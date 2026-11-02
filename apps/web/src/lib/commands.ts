import { signCommand, verifyObject, type CommandReplyBody } from "@agent-office/shared";
import type { Device } from "./device";
import type { HubClient } from "./hub";

export type Runner = <T>(type: string, payload?: Record<string, unknown>) => Promise<T>;

/**
 * Sends one signed command to an office and checks the signed reply against the host key pinned when
 * this device was paired. The hub only relays: a reply it forged or changed is refused here.
 */
export function officeRunner(hub: HubClient, device: Device | null, officeId: string, pinnedKey: string | undefined): Runner {
  return async <T,>(type: string, payload: Record<string, unknown> = {}): Promise<T> => {
    if (!device || !pinnedKey) throw new Error("Pair this device first.");
    const cmd = await signCommand(device.signer, device.deviceId, officeId, { type, payload });
    const env = await hub.request<{ body: CommandReplyBody; sig: string }>(officeId, cmd, cmd.nonce);
    if (!(await verifyObject(pinnedKey, env))) throw new Error("That reply was not signed by this office's host, so it was ignored.");
    if (!env.body.ok) throw new Error(env.body.error ?? "The office refused the command.");
    return env.body.result as T;
  };
}
