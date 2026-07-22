import { runtimeAuthSecretError } from "../src/lib/runtime-config";

function main() {
  const error = runtimeAuthSecretError(process.env);
  if (error) {
    console.error(`Runtime configuration error: ${error}`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write("Runtime authentication configuration validated.\n");
}

if (process.argv[1]?.endsWith("validate-runtime-config.ts")) main();
