import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

export interface AtomicWriteOptions {
  mode?: number;
  /** Optional validation/fault-injection hook run after fsync and before rename. */
  beforeRename?: (temporaryPath: string) => void;
}

export interface AtomicCreateOptions {
  mode?: number;
  /** Optional validation/fault-injection hook run after fsync and before publish. */
  beforePublish?: (temporaryPath: string) => void;
}

function fsyncDirectory(directory: string) {
  const directoryFd = fs.openSync(directory, fs.constants.O_RDONLY);
  try {
    fs.fsyncSync(directoryFd);
  } finally {
    fs.closeSync(directoryFd);
  }
}

/**
 * Durably replace a text file without ever truncating the prior destination.
 * The temporary file is created beside the destination so rename is atomic.
 */
export function atomicWriteTextFileSync(
  destinationPath: string,
  contents: string,
  options: AtomicWriteOptions = {}
): void {
  const directory = path.dirname(destinationPath);
  fs.mkdirSync(directory, { recursive: true });
  const temporaryPath = path.join(
    directory,
    `.${path.basename(destinationPath)}.${process.pid}.${randomUUID()}.tmp`
  );
  let fd: number | null = null;

  try {
    fd = fs.openSync(
      temporaryPath,
      fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY,
      options.mode ?? 0o600
    );
    fs.writeFileSync(fd, contents, "utf8");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;

    options.beforeRename?.(temporaryPath);
    fs.renameSync(temporaryPath, destinationPath);
    fsyncDirectory(directory);
  } catch (error) {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // Preserve the original write failure.
      }
    }
    try {
      fs.unlinkSync(temporaryPath);
    } catch (cleanupError) {
      if ((cleanupError as NodeJS.ErrnoException).code !== "ENOENT") {
        // Preserve the original write failure; a same-directory orphan is safe
        // and can be removed by normal runtime-data maintenance.
      }
    }
    throw error;
  }
}

/**
 * Durably publish a fully-written immutable file without replacing an existing
 * destination. Returns false when another writer already published it.
 */
export function atomicCreateBufferFileSync(
  destinationPath: string,
  contents: Buffer,
  options: AtomicCreateOptions = {}
): boolean {
  const directory = path.dirname(destinationPath);
  fs.mkdirSync(directory, { recursive: true });
  const temporaryPath = path.join(
    directory,
    `.${path.basename(destinationPath)}.${process.pid}.${randomUUID()}.tmp`
  );
  let fd: number | null = null;

  try {
    fd = fs.openSync(
      temporaryPath,
      fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY,
      options.mode ?? 0o600
    );
    fs.writeFileSync(fd, contents);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    options.beforePublish?.(temporaryPath);

    try {
      // Linking is an atomic no-replace publish operation. Unlike rename, it
      // cannot silently overwrite an immutable evidence blob in a race.
      fs.linkSync(temporaryPath, destinationPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw error;
    }
    fsyncDirectory(directory);
    return true;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // Preserve the original failure.
      }
    }
    try {
      fs.unlinkSync(temporaryPath);
    } catch (cleanupError) {
      if ((cleanupError as NodeJS.ErrnoException).code !== "ENOENT") {
        // Preserve the original failure; the unpublished temporary file is not
        // addressable as evidence and can be removed by maintenance.
      }
    }
  }
}
