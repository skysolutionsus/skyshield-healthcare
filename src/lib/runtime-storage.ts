import * as fs from "fs";
import * as os from "os";
import * as path from "path";

function canWriteDirectory(dir: string): boolean {
    try {
        fs.mkdirSync(dir, { recursive: true });
        fs.accessSync(dir, fs.constants.W_OK);
        return true;
    } catch {
        return false;
    }
}

function runtimeDataRoot(): string {
    const configuredRoot = process.env.SKYSHIELD_RUNTIME_DATA_DIR;
    if (configuredRoot) {
        const resolved = path.resolve(configuredRoot);
        if (!canWriteDirectory(resolved)) {
            throw new Error(`SKYSHIELD_RUNTIME_DATA_DIR is not writable: ${resolved}`);
        }
        return resolved;
    }

    const projectDataDir = path.join(process.cwd(), "data");
    if (canWriteDirectory(projectDataDir)) {
        return projectDataDir;
    }

    const tempDataDir = path.join(os.tmpdir(), "skyshield-data");
    if (canWriteDirectory(tempDataDir)) {
        return tempDataDir;
    }

    throw new Error("No writable runtime storage directory is available for SkyShield uploads.");
}

export function runtimeDataDir(subdir: string): string {
    const safeSubdir = subdir
        .split(/[\\/]+/)
        .filter(Boolean)
        .map((part) => part.replace(/[^a-z0-9._-]+/gi, "-"))
        .join(path.sep);
    const dir = path.join(runtimeDataRoot(), safeSubdir);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

export function storedPathForRuntimeFile(absolutePath: string): string {
    const relative = path.relative(process.cwd(), absolutePath);
    if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) {
        return relative;
    }
    return absolutePath;
}

export function resolveRuntimeFilePath(storedPath: string): string {
    return path.isAbsolute(storedPath) ? storedPath : path.resolve(process.cwd(), storedPath);
}
