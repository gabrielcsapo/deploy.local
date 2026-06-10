#!/usr/bin/env node
export {};

const command = process.argv[2];
const argv = process.argv.slice(3);

/** Read `--flag value` or `--flag=value` from the trailing args. */
function getFlag(name: string): string | undefined {
  const eq = argv.find((a) => a.startsWith(`${name}=`));
  if (eq) return eq.slice(name.length + 1);
  const idx = argv.indexOf(name);
  if (idx !== -1 && argv[idx + 1] && !argv[idx + 1].startsWith("-")) {
    return argv[idx + 1];
  }
  return undefined;
}

function hasFlag(name: string): boolean {
  return argv.includes(name);
}

function printUsage(): void {
  console.log("Usage: react-flight-router <command> [options]");
  console.log("");
  console.log("Commands:");
  console.log("  dev      Start the development server (RSC + SSR + HMR)");
  console.log("  build    Build the app for production");
  console.log("");
  console.log("Dev options:");
  console.log("  --port <n>   Port to listen on (default: 5173)");
  console.log("  --host [h]   Expose on the network, or bind a specific host");
  console.log("  --open       Open the browser on start");
}

if (command === "build") {
  const { build } = await import("../build/build-orchestrator.js");
  build({ appRoot: process.cwd() }).catch((err) => {
    console.error("Build failed:", err);
    process.exit(1);
  });
} else if (command === "dev") {
  const { startDevServer } = await import("../dev/dev-server.js");
  const portRaw = getFlag("--port");
  // `--host` with no value exposes on the network (boolean true); `--host 0.0.0.0`
  // binds a specific host.
  const hostValue = getFlag("--host");
  startDevServer({
    appRoot: process.cwd(),
    port: portRaw ? Number(portRaw) : undefined,
    host: hostValue ?? (hasFlag("--host") || undefined),
    open: hasFlag("--open"),
  }).catch((err) => {
    console.error("Dev server failed:", err);
    process.exit(1);
  });
} else {
  printUsage();
  process.exit(command ? 1 : 0);
}
