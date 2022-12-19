import fs from "fs/promises";

import type { Logger } from "@temporalio/worker";
import { v4 as uuidv4 } from "uuid";
import type { ValidationError } from "~/schema/utils.server";
import { Token } from "~/token";
import { displayError } from "~/utils.shared";

import { execCmdWithOpts } from "../utils";

import { RemoteInfoTupleValidator } from "./validator";

export interface GitRemoteInfo {
  /** The name of the remote, e.g. `refs/heads/master` */
  name: string;
  /** The hash of the object the remote is pointing to, in other words
   * commit hash. E.g. `8e5423e991e8cd0988d0c4a3f4ac4ca1af7d148a` */
  hash: string;
}

interface ParseError {
  error: ValidationError;
  value: string;
}

interface RemoteUpdate {
  state: "new" | "updated" | "deleted";
  remoteInfo: GitRemoteInfo;
}

export class GitService {
  static inject = [Token.Logger] as const;

  constructor(private readonly logger: Logger) {}

  private parseLsRemoteOutput(output: string): {
    remotes: GitRemoteInfo[];
    errors: ParseError[];
  } {
    const remotes: GitRemoteInfo[] = [];
    const errors: ParseError[] = [];

    output
      .toString()
      .split("\n")
      .filter((line) => line.length > 0)
      .forEach((line) => {
        const words = line.split(/\s/);
        const result = RemoteInfoTupleValidator.SafeParse(words);
        if (result.success) {
          const value = result.value;
          remotes.push({ hash: value[0], name: value[1] });
        } else {
          errors.push({ error: result.error, value: line });
        }
      });

    return { remotes, errors };
  }

  private async writeKey(pathToPrivateKey: string, key: string): Promise<void> {
    const contents = key.endsWith("\n") ? key : `${key}\n`;
    await fs.writeFile(pathToPrivateKey, contents);
    await fs.chmod(pathToPrivateKey, 0o600);
  }

  /**
   * Even if the repository is public, we still need to provide a private key.
   * This is because many providers (GitHub in particular) will reject SSH
   * connections that don't use a private key.
   *
   * This private key must be added to GitHub somewhere. It can be added to a
   * different account than the one that owns the repository. Or it can even
   * be a deploy key for a diffrerent repository. But GitHub must know
   * that it exists, otherwise it will reject the connection.
   */
  async getRemotes(repositoryUrl: string, privateKey: string): Promise<GitRemoteInfo[]> {
    const pathToPrivateKey = `/tmp/${uuidv4()}.key`;
    try {
      await this.writeKey(pathToPrivateKey, privateKey);
      const output = await execCmdWithOpts(["git", "ls-remote", repositoryUrl], {
        env: { GIT_SSH_COMMAND: `ssh -i "${pathToPrivateKey}" -o StrictHostKeyChecking=no` },
      });
      const result = this.parseLsRemoteOutput(output.stdout.toString());
      for (const { error, value } of result.errors) {
        this.logger.error(
          `Failed to parse git ls-remote output:\n${error.message}\nOffending value: "${value}"`,
        );
      }
      return result.remotes;
    } finally {
      await fs.unlink(pathToPrivateKey).catch((err) => {
        this.logger.warn(
          `Failed to delete private key file ${pathToPrivateKey}\n${displayError(err)})}`,
        );
      });
    }
  }

  async findRemoteUpdates(
    oldRemotes: GitRemoteInfo[],
    newRemotes: GitRemoteInfo[],
  ): Promise<RemoteUpdate[]> {
    const oldRemotesMap = new Map(oldRemotes.map((r) => [r.name, r.hash]));
    const updatedRemotes: RemoteUpdate[] = [];
    const accessedRemotes = new Set<string>();
    for (const remote of newRemotes) {
      accessedRemotes.add(remote.name);
      const oldHash = oldRemotesMap.get(remote.name);
      if (oldHash !== remote.hash) {
        updatedRemotes.push({ remoteInfo: remote, state: oldHash != null ? "updated" : "new" });
      }
    }
    for (const remote of oldRemotes) {
      if (!accessedRemotes.has(remote.name)) {
        updatedRemotes.push({ remoteInfo: remote, state: "deleted" });
      }
    }
    return updatedRemotes;
  }
}
