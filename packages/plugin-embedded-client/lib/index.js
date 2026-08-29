// src/index.ts
import { writeFileSync } from "node:fs";

// src/listen.ts
function findListenAddress(ctx) {
  const webServer = readWebServer(ctx);
  if (!webServer) return null;
  const publishedPort = readPort(webServer.port);
  if (publishedPort !== null) {
    return {
      host: normalizeHost(typeof webServer.host === "string" ? webServer.host : "127.0.0.1"),
      port: publishedPort
    };
  }
  for (const server of collectServers(webServer)) {
    const address = typeof server?.address === "function" ? server.address() : null;
    if (address && typeof address === "object") {
      const addr = address;
      const port = readPort(addr.port);
      if (port !== null) {
        const host = typeof addr.address === "string" && addr.address.length > 0 ? normalizeHost(addr.address) : "127.0.0.1";
        return { host, port };
      }
    }
  }
  return null;
}
function readPort(value) {
  return typeof value === "number" && Number.isInteger(value) && value > 0 && value <= 65535 ? value : null;
}
function normalizeHost(address) {
  if (address === "::" || address === "::1" || address === "0.0.0.0" || address === "::ffff:0.0.0.0" || address === "::ffff:127.0.0.1") return "127.0.0.1";
  return address;
}
function collectServers(webServer) {
  const candidates = [
    webServer,
    webServer.server,
    webServer.httpServer,
    webServer.listener
  ];
  return candidates.map(asServer);
}
function readWebServer(ctx) {
  if (!ctx || typeof ctx !== "object") return void 0;
  const root = ctx;
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
  let checking = false;
  let disposed = false;
  const tick = () => {
    if (written || checking || disposed) return;
    const addr = findListenAddress(ctx);
    if (!addr) return;
    checking = true;
    void probeWebUi(addr.port).then((ready) => {
      checking = false;
      if (!ready || written || disposed) return;
      try {
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
      } catch {
      }
    });
  };
  if (typeof ctx.effect === "function") {
    ctx.effect(() => {
      const timer2 = setInterval(tick, 100);
      tick();
      return () => {
        disposed = true;
        clearInterval(timer2);
      };
    });
    return;
  }
  const timer = setInterval(tick, 100);
  tick();
  ctx.on?.("dispose", () => {
    disposed = true;
    clearInterval(timer);
  });
}
async function probeWebUi(port) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1e3);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/`, {
      signal: controller.signal,
      redirect: "manual"
    });
    if (!response.ok) return false;
    const contentType = response.headers.get("content-type") ?? "";
    if (contentType !== "" && !contentType.toLowerCase().includes("text/html")) return false;
    const html = await response.text();
    return /<!doctype\s+html|<html(?:\s|>)/i.test(html);
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}
export {
  apply,
  inject,
  name
};
