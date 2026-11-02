import { scrubText, scrubValue } from "@agent-office/shared";
import type { Vault } from "./vault";

export class CredentialError extends Error {}

/**
 * The only code that may read secrets. Callers pass a function that uses the
 * secret (to set an HTTP header, an env var for a tool process, ...). The
 * secret is never returned, so it cannot end up in a model message by accident.
 */
export class CredentialBroker {
  constructor(private readonly vault: Vault) {}

  async withCredential<T>(projectId: string, handle: string, use: (secret: string) => Promise<T> | T): Promise<T> {
    const secret = this.vault.readSecret(projectId, handle);
    if (secret === undefined) throw new CredentialError(`no credential "${handle}" in this project`);
    return use(secret);
  }

  /** Removes this project's secret values (and known token formats) from text. */
  scrub(projectId: string, text: string): string {
    return scrubText(text, this.vault.allSecrets(projectId));
  }

  scrubValue<T>(projectId: string, value: T): T {
    return scrubValue(value, this.vault.allSecrets(projectId));
  }
}
