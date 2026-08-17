import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

async function source(path: string): Promise<string> {
  return readFile(new URL(`../${path}`, import.meta.url), "utf8");
}

async function main() {
  const [shell, agent, login, incidents, auditTable, settings, incidentDialog] = await Promise.all([
    source("src/components/app-shell.tsx"),
    source("src/app/(authenticated)/agent/page.tsx"),
    source("src/app/login/page.tsx"),
    source("src/app/(authenticated)/incidents/page.tsx"),
    source("src/components/audit-log-table.tsx"),
    source("src/app/(authenticated)/settings/page.tsx"),
    source("src/components/new-incident-dialog.tsx"),
  ]);

  assert.match(shell, /h-dvh/);
  assert.match(shell, /min-h-0 flex-1 overflow-y-auto/);
  assert.doesNotMatch(shell, /\bh-screen\b/);
  assert.match(shell, /aria-label="Open navigation"/);
  assert.match(shell, /min-h-11 min-w-11/);

  assert.match(agent, /useState\(false\)/);
  assert.match(agent, /relative flex h-full min-h-0 overflow-hidden/);
  assert.match(agent, /absolute inset-y-0 left-0 z-30/);
  assert.match(agent, /lg:static/);
  assert.match(agent, /text-base[^"\n]*sm:text-sm/);
  assert.doesNotMatch(agent, /calc\(100vh/);

  assert.match(login, /min-h-dvh/);
  assert.match(login, /overflow-y-auto/);
  assert.match(login, /text-base[^"\n]*sm:text-sm/);
  assert.match(login, /aria-label=\{showPassword \? "Hide password" : "Show password"\}/);

  assert.match(incidents, /md:hidden/);
  assert.match(incidents, /hidden overflow-x-auto md:block/);
  assert.match(auditTable, /divide-y[^"\n]*md:hidden/);
  assert.match(auditTable, /hidden overflow-x-auto md:block/);
  assert.match(settings, /divide-y[^"\n]*md:hidden/);
  assert.match(settings, /hidden overflow-x-auto md:block/);

  assert.match(incidentDialog, /100dvh/);
  assert.match(incidentDialog, /grid-cols-1[^"\n]*sm:grid-cols-2/);
  assert.match(incidentDialog, /flex-col-reverse[^"\n]*sm:flex-row/);

  console.log("Mobile responsive layout regression checks passed.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
