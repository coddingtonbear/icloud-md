/**
 * How the live harness reaches CloudKit directly, from inside the test
 * runner rather than through a `runCli` subprocess.
 *
 * The one rule that matters here, and the reason this is shared rather than
 * copied per helper: **the harness may never open a sign-in window**. There is
 * nobody at this browser to complete one, so it would simply block until
 * something closed it; a lapsed session must fail the run loudly instead.
 * Two helpers each keeping their own copy of that rule is exactly how one of
 * them ends up without it.
 *
 * The subprocess side of the same rule is `clone --non-interactive`, which
 * `vault.ts` passes.
 */

import { Buffer } from "node:buffer";
import { resolveFolderAccount } from "../src/auth/folderAuth.js";
import { noteZone, type NoteZone } from "../src/cloudkit/databaseClient.js";
import type { IcloudSession } from "../src/session.js";
import { readCloneState } from "../src/notes/cloneState.js";

export interface HarnessAccount {
  session: IcloudSession;
  ckdatabasewsUrl: string;
  dsid: string;
  /** The private Notes zone. Shared zones are out of scope: these helpers are
   * test fixtures, not general writers. */
  zone: NoteZone;
  /** The clone's own CRDT replica identity - the same one its pushes use. */
  replicaId: Uint8Array;
}

/**
 * Resolves the account a clone is bound to, the way `push` does, minus the
 * ability to log in interactively.
 */
export async function resolveHarnessAccount(vaultDir: string): Promise<HarnessAccount> {
  const state = await readCloneState(vaultDir);
  if (!state) {
    throw new Error(`${vaultDir} is not a clone - cannot resolve an account to write through`);
  }
  if (state.replicaId === undefined) {
    throw new Error("The clone has no replicaId yet - push something through it before writing to CloudKit directly");
  }

  const auth = await resolveFolderAccount(vaultDir, state.account, {
    performBrowserLogin: () => {
      throw new Error(
        "The saved sign-in has lapsed. Re-authenticate before running the live suite " +
          "(the integration harness must never open a sign-in window mid-run).",
      );
    },
  });
  if (!auth.ckdatabasewsUrl) {
    throw new Error("The account resolved without a CloudKit database host");
  }

  return {
    session: auth.session,
    ckdatabasewsUrl: auth.ckdatabasewsUrl,
    dsid: auth.dsid,
    zone: noteZone(undefined),
    replicaId: new Uint8Array(Buffer.from(state.replicaId, "base64")),
  };
}
