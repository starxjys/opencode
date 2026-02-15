import type { Server as HttpServer } from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WebSocketServer } from "ws";
import { CANVAS_HOST_PATH } from "../canvas-host/a2ui.js";
import { type CanvasHostHandler, createCanvasHostHandler } from "../canvas-host/server.js";
import type { CliDeps } from "../cli/deps.js";
import type { createSubsystemLogger } from "../logging/subsystem.js";
import type { PluginRegistry } from "../plugins/registry.js";
import type { RuntimeEnv } from "../runtime.js";
import type { AuthRateLimiter } from "./auth-rate-limit.js";
import type { ResolvedGatewayAuth } from "./auth.js";
import type { ChatAbortControllerEntry } from "./chat-abort.js";
import type { ControlUiRootState } from "./control-ui.js";
import type { HooksConfigResolved } from "./hooks.js";
import type { DedupeEntry } from "./server-shared.js";
import type { GatewayTlsRuntime } from "./server/tls.js";
import type { GatewayWsClient } from "./server/ws-types.js";
import { CANVAS_HOST_PATH } from "../canvas-host/a2ui.js";
import { type CanvasHostHandler, createCanvasHostHandler } from "../canvas-host/server.js";
import { resolveStateDir } from "../config/paths.js";
import { resolveGatewayListenHosts } from "./net.js";
import {
  createGatewayBroadcaster,
  type GatewayBroadcastFn,
  type GatewayBroadcastToConnIdsFn,
} from "./server-broadcast.js";
import {
  type ChatRunEntry,
  createChatRunState,
  createToolEventRecipientRegistry,
} from "./server-chat.js";
import { MAX_PAYLOAD_BYTES } from "./server-constants.js";
import { attachGatewayUpgradeHandler, createGatewayHttpServer } from "./server-http.js";
import type { DedupeEntry } from "./server-shared.js";
import { createGatewayHooksRequestHandler } from "./server/hooks.js";
import { listenGatewayHttpServer } from "./server/http-listen.js";
import { createGatewayPluginRequestHandler } from "./server/plugins-http.js";

/**
 * Create a Unix domain socket server for local gateway access.
 * Unix socket connections automatically skip device pairing when using valid credentials.
 */
async function createUnixSocketServer(params: {
  socketPath: string;
  wss: WebSocketServer;
  canvasHost: CanvasHostHandler | null;
  clients: Set<GatewayWsClient>;
  resolvedAuth: ResolvedGatewayAuth;
  rateLimiter?: AuthRateLimiter;
  handleHooksRequest: ReturnType<typeof createGatewayHooksRequestHandler> | null;
  handlePluginRequest: ReturnType<typeof createGatewayPluginRequestHandler>;
  log: { info: (msg: string) => void; warn: (msg: string) => void };
}): Promise<HttpServer | null> {
  // Check Windows compatibility
  if (process.platform === "win32") {
    const winVersion = os.release();
    const [major, , build] = winVersion.split(".").map(Number);
    // Windows 10 1803 (build 17134) and later support Unix sockets
    if (major < 10 || (major === 10 && build < 17134)) {
      params.log.warn("unix socket not supported on this Windows version, skipping");
      return null;
    }
  }

  try {
    // Clean up old socket file
    await fs.unlink(params.socketPath).catch(() => {});

    // Ensure directory exists
    await fs.mkdir(path.dirname(params.socketPath), { recursive: true });

    // Create HTTP server for Unix socket
    const unixServer = createGatewayHttpServer({
      canvasHost: params.canvasHost,
      clients: params.clients,
      controlUiEnabled: false, // Unix socket doesn't serve Control UI
      controlUiBasePath: "",
      openAiChatCompletionsEnabled: false,
      openResponsesEnabled: false,
      handleHooksRequest: params.handleHooksRequest,
      handlePluginRequest: params.handlePluginRequest,
      resolvedAuth: params.resolvedAuth,
      rateLimiter: params.rateLimiter,
      tlsOptions: undefined, // Unix socket doesn't need TLS
    });

    // Listen on Unix socket
    await new Promise<void>((resolve, reject) => {
      unixServer.once("error", reject);
      unixServer.listen(params.socketPath, () => {
        unixServer.removeListener("error", reject);
        resolve();
      });
    });

    // Set strict file permissions (owner read/write only)
    await fs.chmod(params.socketPath, 0o600);

    // Attach WebSocket upgrade handler
    attachGatewayUpgradeHandler({
      httpServer: unixServer,
      wss: params.wss,
      canvasHost: params.canvasHost,
      clients: params.clients,
      resolvedAuth: params.resolvedAuth,
      rateLimiter: params.rateLimiter,
    });

    params.log.info(`gateway unix socket listening at ${params.socketPath}`);
    return unixServer;
  } catch (err) {
    params.log.warn(`failed to create unix socket server: ${String(err)}`);
    return null;
  }
}

export async function createGatewayRuntimeState(params: {
  cfg: import("../config/config.js").OpenClawConfig;
  bindHost: string;
  port: number;
  controlUiEnabled: boolean;
  controlUiBasePath: string;
  controlUiRoot?: ControlUiRootState;
  openAiChatCompletionsEnabled: boolean;
  openResponsesEnabled: boolean;
  openResponsesConfig?: import("../config/types.gateway.js").GatewayHttpResponsesConfig;
  resolvedAuth: ResolvedGatewayAuth;
  /** Optional rate limiter for auth brute-force protection. */
  rateLimiter?: AuthRateLimiter;
  gatewayTls?: GatewayTlsRuntime;
  hooksConfig: () => HooksConfigResolved | null;
  pluginRegistry: PluginRegistry;
  deps: CliDeps;
  canvasRuntime: RuntimeEnv;
  canvasHostEnabled: boolean;
  allowCanvasHostInTests?: boolean;
  logCanvas: { info: (msg: string) => void; warn: (msg: string) => void };
  log: { info: (msg: string) => void; warn: (msg: string) => void };
  logHooks: ReturnType<typeof createSubsystemLogger>;
  logPlugins: ReturnType<typeof createSubsystemLogger>;
}): Promise<{
  canvasHost: CanvasHostHandler | null;
  httpServer: HttpServer;
  httpServers: HttpServer[];
  httpBindHosts: string[];
  wss: WebSocketServer;
  clients: Set<GatewayWsClient>;
  broadcast: GatewayBroadcastFn;
  broadcastToConnIds: GatewayBroadcastToConnIdsFn;
  agentRunSeq: Map<string, number>;
  dedupe: Map<string, DedupeEntry>;
  chatRunState: ReturnType<typeof createChatRunState>;
  chatRunBuffers: Map<string, string>;
  chatDeltaSentAt: Map<string, number>;
  addChatRun: (sessionId: string, entry: ChatRunEntry) => void;
  removeChatRun: (
    sessionId: string,
    clientRunId: string,
    sessionKey?: string,
  ) => ChatRunEntry | undefined;
  chatAbortControllers: Map<string, ChatAbortControllerEntry>;
  toolEventRecipients: ReturnType<typeof createToolEventRecipientRegistry>;
  unixSocketPath?: string;
}> {
  let canvasHost: CanvasHostHandler | null = null;
  if (params.canvasHostEnabled) {
    try {
      const handler = await createCanvasHostHandler({
        runtime: params.canvasRuntime,
        rootDir: params.cfg.canvasHost?.root,
        basePath: CANVAS_HOST_PATH,
        allowInTests: params.allowCanvasHostInTests,
        liveReload: params.cfg.canvasHost?.liveReload,
      });
      if (handler.rootDir) {
        canvasHost = handler;
        params.logCanvas.info(
          `canvas host mounted at http://${params.bindHost}:${params.port}${CANVAS_HOST_PATH}/ (root ${handler.rootDir})`,
        );
      }
    } catch (err) {
      params.logCanvas.warn(`canvas host failed to start: ${String(err)}`);
    }
  }

  const clients = new Set<GatewayWsClient>();
  const { broadcast, broadcastToConnIds } = createGatewayBroadcaster({ clients });

  const handleHooksRequest = createGatewayHooksRequestHandler({
    deps: params.deps,
    getHooksConfig: params.hooksConfig,
    bindHost: params.bindHost,
    port: params.port,
    logHooks: params.logHooks,
  });

  const handlePluginRequest = createGatewayPluginRequestHandler({
    registry: params.pluginRegistry,
    log: params.logPlugins,
  });

  const bindHosts = await resolveGatewayListenHosts(params.bindHost);
  const httpServers: HttpServer[] = [];
  const httpBindHosts: string[] = [];
  for (const host of bindHosts) {
    const httpServer = createGatewayHttpServer({
      canvasHost,
      clients,
      controlUiEnabled: params.controlUiEnabled,
      controlUiBasePath: params.controlUiBasePath,
      controlUiRoot: params.controlUiRoot,
      openAiChatCompletionsEnabled: params.openAiChatCompletionsEnabled,
      openResponsesEnabled: params.openResponsesEnabled,
      openResponsesConfig: params.openResponsesConfig,
      handleHooksRequest,
      handlePluginRequest,
      resolvedAuth: params.resolvedAuth,
      rateLimiter: params.rateLimiter,
      tlsOptions: params.gatewayTls?.enabled ? params.gatewayTls.tlsOptions : undefined,
    });
    try {
      await listenGatewayHttpServer({
        httpServer,
        bindHost: host,
        port: params.port,
      });
      httpServers.push(httpServer);
      httpBindHosts.push(host);
    } catch (err) {
      if (host === bindHosts[0]) {
        throw err;
      }
      params.log.warn(
        `gateway: failed to bind loopback alias ${host}:${params.port} (${String(err)})`,
      );
    }
  }
  const httpServer = httpServers[0];
  if (!httpServer) {
    throw new Error("Gateway HTTP server failed to start");
  }

  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_PAYLOAD_BYTES,
  });
  for (const server of httpServers) {
    attachGatewayUpgradeHandler({
      httpServer: server,
      wss,
      canvasHost,
      clients,
      resolvedAuth: params.resolvedAuth,
      rateLimiter: params.rateLimiter,
    });
  }

  const agentRunSeq = new Map<string, number>();
  const dedupe = new Map<string, DedupeEntry>();
  const chatRunState = createChatRunState();
  const chatRunRegistry = chatRunState.registry;
  const chatRunBuffers = chatRunState.buffers;
  const chatDeltaSentAt = chatRunState.deltaSentAt;
  const addChatRun = chatRunRegistry.add;
  const removeChatRun = chatRunRegistry.remove;
  const chatAbortControllers = new Map<string, ChatAbortControllerEntry>();
  const toolEventRecipients = createToolEventRecipientRegistry();

  // Create Unix socket server for local access (skip pairing)
  const unixSocketPath = path.join(params.deps.configDir ?? resolveStateDir(), "gateway.sock");
  const unixServer = await createUnixSocketServer({
    socketPath: unixSocketPath,
    wss,
    canvasHost,
    clients,
    resolvedAuth: params.resolvedAuth,
    rateLimiter: params.rateLimiter,
    handleHooksRequest,
    handlePluginRequest,
    log: params.log,
  });
  if (unixServer) {
    httpServers.push(unixServer);
  }

  return {
    canvasHost,
    httpServer,
    httpServers,
    httpBindHosts,
    wss,
    clients,
    broadcast,
    broadcastToConnIds,
    agentRunSeq,
    dedupe,
    chatRunState,
    chatRunBuffers,
    chatDeltaSentAt,
    addChatRun,
    removeChatRun,
    chatAbortControllers,
    toolEventRecipients,
    unixSocketPath: unixServer ? unixSocketPath : undefined,
  };
}
