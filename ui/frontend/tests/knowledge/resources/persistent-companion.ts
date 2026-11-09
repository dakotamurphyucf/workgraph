import { spawn } from "node:child_process";
import { mkdtemp, realpath, rm, rename, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { decodeReady } from "../../../../test-support/companion-fixture.mjs";
/** Test-owned restartable root. Stops only its spawned child; cleanup remains
 * independent from restart so durable helper/journal replay is exercised. */
export async function persistentCompanion(binary: string) {
  const root = await realpath(await mkdtemp("/tmp/wgui-resource-replay-"));
  let running: Awaited<ReturnType<typeof launch>> | null = null;
  const events: unknown[] = [];
  async function launch() {
    const child = spawn(binary, ["--state-root", root, "--no-open"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = Buffer.alloc(0),
      stdout = Buffer.alloc(0),
      exit: { code: number | null; signal: NodeJS.Signals | null } | null = null;
    child.stderr.on("data", (b: Buffer) => {
      stderr = Buffer.concat([stderr, b]).subarray(-65536);
    });
    const closed = new Promise<void>((resolve) =>
      child.once("close", (code, signal) => {
        exit = { code, signal };
        resolve();
      }),
    );
    const stop = async () => {
      if (exit === null) {
        child.kill("SIGTERM");
        if (!(await Promise.race([closed.then(() => true), delay(3000, false)]))) {
          child.kill("SIGKILL");
          if (!(await Promise.race([closed.then(() => true), delay(3000, false)])))
            throw new Error("Owned companion failed to stop");
        }
      }
      events.push({ pid: child.pid, exit, stderr: stderr.toString("utf8") });
    };
    const ready = new Promise<ReturnType<typeof decodeReady>>((resolve, reject) => {
      child.stdout.on("data", (b: Buffer) => {
        stdout = Buffer.concat([stdout, b]);
        if (stdout.length > 65536) {
          reject(new Error("Oversized readiness"));
          return;
        }
        const end = stdout.indexOf(10);
        if (end >= 0) {
          try {
            resolve(decodeReady(stdout.subarray(0, end), root));
          } catch (error) {
            reject(
              error instanceof Error
                ? error
                : new Error("Unexpected readiness decode failure", { cause: error }),
            );
          }
        }
      });
      child.once("error", reject);
      void closed.then(() => {
        reject(new Error(`Owned companion exited before readiness: ${stderr.toString("utf8")}`));
      });
    });
    try {
      const value = await Promise.race([
        ready,
        delay(10000).then(() => {
          throw new Error("Owned companion readiness timeout");
        }),
      ]);
      return { url: value.url, stop };
    } catch (error) {
      await stop();
      throw error;
    }
  }
  try {
    running = await launch();
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
  return {
    get url() {
      return running!.url;
    },
    events,
    blockJournal: async () => {
      const directory = `${root}/requests`,
        backup = `${root}/requests-test-backup`;
      await rename(directory, backup);
      try {
        await writeFile(directory, "Synthetic test-owned journal directory obstruction");
      } catch (error) {
        await rename(backup, directory);
        throw error;
      }
      return async () => {
        await rm(directory);
        await rename(backup, directory);
      };
    },
    restart: async () => {
      await running!.stop();
      running = await launch();
    },
    dispose: async () => {
      try {
        await running?.stop();
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  };
}
