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

// src/web-auth.ts
function readConnection(ctx) {
  if (!ctx || typeof ctx !== "object") return void 0;
  const root = ctx;
  const get = root.get;
  if (typeof get !== "function") return void 0;
  try {
    const value = get.call(ctx, "connection");
    return value && typeof value === "object" ? value : void 0;
  } catch {
    return void 0;
  }
}
function browserUrlFor(ctx, baseUrl) {
  const connection = readConnection(ctx);
  if (typeof connection?.authenticatedUrl !== "function") return baseUrl;
  try {
    return connection.authenticatedUrl(baseUrl);
  } catch {
    return baseUrl;
  }
}
function cookiePair(setCookie) {
  if (!setCookie) return void 0;
  const pair = setCookie.split(";", 1)[0]?.trim();
  return pair ? pair : void 0;
}
function isLoopbackHost(hostname) {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}
function safeBrowserUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:" || !isLoopbackHost(url.hostname)) return null;
    if (url.username || url.password || url.hash) return null;
    return url;
  } catch {
    return null;
  }
}
function sameOriginLocation(location, base) {
  try {
    const resolved = new URL(location, base);
    return resolved.origin === base.origin ? resolved : null;
  } catch {
    return null;
  }
}
async function htmlResponse(response) {
  if (!response.ok) return false;
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (contentType !== "" && !contentType.includes("text/html")) return false;
  const html = await response.text();
  return /<!doctype\s+html|<html(?:\s|>)/i.test(html);
}
async function probeBrowserUrl(url, timeoutMs = 1e3) {
  const baseUrl = safeBrowserUrl(url);
  if (!baseUrl) return false;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const initial = await fetch(baseUrl, { signal: controller.signal, redirect: "manual" });
    if (await htmlResponse(initial)) return true;
    if (initial.status !== 303) return false;
    const location = initial.headers.get("location");
    const cookie = cookiePair(initial.headers.get("set-cookie"));
    if (!location || !cookie) return false;
    const cleanUrl = sameOriginLocation(location, baseUrl);
    if (!cleanUrl) return false;
    const page = await fetch(cleanUrl, {
      signal: controller.signal,
      redirect: "manual",
      headers: { cookie }
    });
    return htmlResponse(page);
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

// src/index.ts
var name = "embedded-client";
var inject = ["webServer", "connection"];
function getService(ctx, name2) {
  try {
    return ctx.get?.(name2);
  } catch {
    return void 0;
  }
}
function loaderSettlement(ctx) {
  const loader = getService(ctx, "loader");
  return typeof loader?.await === "function" ? loader.await() : void 0;
}
function runtimeServicesPresent(ctx) {
  if (typeof ctx.get !== "function") {
    return ctx.webServer !== void 0 && ctx.connection !== void 0;
  }
  return getService(ctx, "webServer") !== void 0 && getService(ctx, "connection") !== void 0;
}
function apply(ctx) {
  const readyFile = process.env.DSH_EMBEDDED_READY_FILE;
  if (!readyFile) return;
  const generation = Number.parseInt(process.env.HARNESSDOCK_RUNTIME_GENERATION ?? "", 10);
  const nonce = process.env.HARNESSDOCK_RUNTIME_NONCE ?? "";
  const imageIdentity = process.env.HARNESSDOCK_RUNTIME_IMAGE_IDENTITY ?? "";
  if (!Number.isSafeInteger(generation) || generation <= 0 || !nonce || !imageIdentity) {
    return;
  }
  let written = false;
  let checking = false;
  let disposed = false;
  let timer;
  let consecutiveHealthyProbes = 0;
  const stop = () => {
    disposed = true;
    if (timer !== void 0) {
      clearInterval(timer);
      timer = void 0;
    }
  };
  const tick = () => {
    if (written || checking || disposed) return;
    if (!runtimeServicesPresent(ctx)) {
      consecutiveHealthyProbes = 0;
      return;
    }
    const addr = findListenAddress(ctx);
    if (!addr) {
      consecutiveHealthyProbes = 0;
      return;
    }
    const baseUrl = `http://127.0.0.1:${addr.port}`;
    const browserUrl = browserUrlFor(ctx, baseUrl);
    checking = true;
    void probeBrowserUrl(browserUrl).then((ready) => {
      checking = false;
      if (written || disposed) return;
      if (!ready || !runtimeServicesPresent(ctx)) {
        consecutiveHealthyProbes = 0;
        return;
      }
      consecutiveHealthyProbes += 1;
      if (consecutiveHealthyProbes < 3) return;
      try {
        const payload = {
          url: browserUrl,
          host: "127.0.0.1",
          port: addr.port,
          pid: process.pid,
          dshVersion: process.env.DSH_EMBEDDED_VERSION ?? "unknown",
          generation,
          nonce,
          imageIdentity
        };
        writeFileSync(readyFile, `${JSON.stringify(payload, null, 2)}
`, {
          encoding: "utf8",
          mode: 384
        });
        written = true;
        if (timer !== void 0) {
          clearInterval(timer);
          timer = void 0;
        }
      } catch {
        consecutiveHealthyProbes = 0;
      }
    }, () => {
      checking = false;
      consecutiveHealthyProbes = 0;
    });
  };
  const beginProbing = () => {
    if (disposed || written || timer !== void 0 || !runtimeServicesPresent(ctx)) return;
    timer = setInterval(tick, 100);
    tick();
  };
  const beginAfterLoaderSettlement = () => {
    const settled = loaderSettlement(ctx);
    if (settled === void 0) {
      beginProbing();
      return;
    }
    void settled.then(() => {
      if (!disposed && runtimeServicesPresent(ctx)) beginProbing();
    }, () => {
      stop();
    });
  };
  if (typeof ctx.effect === "function") {
    ctx.effect(() => {
      beginAfterLoaderSettlement();
      return stop;
    });
    return;
  }
  beginAfterLoaderSettlement();
  ctx.on?.("dispose", stop);
}
export {
  apply,
  inject,
  name
};
