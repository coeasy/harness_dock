// src/index.ts
import { writeFileSync } from "node:fs";

// src/listen.ts
function findListenAddress(ctx) {
  const candidates = collectServers(ctx);
  for (const server of candidates) {
    const address = typeof server?.address === "function" ? server.address() : null;
    if (address && typeof address === "object") {
      const addr = address;
      if (typeof addr.port === "number" && addr.port > 0) {
        const host = typeof addr.address === "string" && addr.address.length > 0 ? normalizeHost(addr.address) : "127.0.0.1";
        return { host, port: addr.port };
      }
    }
  }
  return null;
}
function normalizeHost(address) {
  if (address === "::" || address === "::1") return "127.0.0.1";
  return address;
}
function collectServers(ctx) {
  if (!ctx || typeof ctx !== "object") return [];
  const root = ctx;
  const candidates = [
    asServer(asRecord(readWebServer(root))?.server)
  ];
  return candidates;
}
function readWebServer(root) {
  if (typeof root.get === "function") {
    try {
      return asRecord(root.get("webServer"));
    } catch {
      return void 0;
    }
  }
  return asRecord(root.webServer);
}
function asRecord(value) {
  return value && typeof value === "object" ? value : void 0;
}
function asServer(value) {
  return value && typeof value === "object" ? value : void 0;
}

// src/index.ts
var name = "embedded-client";
var inject = ["webServer"];
function apply(ctx) {
  const readyFile = process.env.DSH_EMBEDDED_READY_FILE;
  if (!readyFile) return;
  let written = false;
  const tick = () => {
    if (written) return;
    const addr = findListenAddress(ctx);
    if (!addr) return;
    const payload = {
      url: `http://127.0.0.1:${addr.port}`,
      host: "127.0.0.1",
      port: addr.port,
      pid: process.pid,
      dshVersion: process.env.DSH_EMBEDDED_VERSION ?? "unknown"
    };
    writeFileSync(readyFile, `${JSON.stringify(payload, null, 2)}
`, "utf8");
    written = true;
  };
  if (typeof ctx.effect === "function") {
    ctx.effect(() => {
      const timer2 = setInterval(tick, 100);
      tick();
      return () => clearInterval(timer2);
    });
    return;
  }
  const timer = setInterval(tick, 100);
  tick();
  ctx.on?.("dispose", () => clearInterval(timer));
}
export {
  apply,
  inject,
  name
};
