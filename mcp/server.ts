/**
 * mcp/server.ts — a local MCP server over stdio.
 *
 * Exposes one tool, `check(token, purpose)`, which returns the verdict, the reasons and the raw
 * inputs. No payments, no signing, no hosted service: it runs on the caller's machine and talks to
 * public RPC endpoints by default (STOCK_CHECK_RPC_URLS selects your own; see README).
 *
 * Protocol: JSON-RPC 2.0, one message per line, on stdin/stdout (the MCP stdio transport).
 * No SDK dependency on purpose — the surface is three methods and a dependency would be larger
 * than the server.
 *
 * Run:  npx tsx mcp/server.ts
 * Logs go to stderr; stdout carries protocol messages only.
 */

import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { check, tokens, coverageLabel, loadFeeds, VERSION } from "../src/index.ts";
import type { Purpose } from "../src/types.ts";

const PROTOCOL_VERSION = "2024-11-05";
const SERVER = { name: "stock-token-check", version: VERSION };

const TOOL = {
  name: "check",
  description:
    "Report whether a Robinhood Stock Token's Chainlink price feed is currently safe to use, and " +
    "why. Returns data conditions only; this is not investment advice. Risks include a closed " +
    "market, a paused oracle or token, a stale feed, and a pending multiplier change.",
  inputSchema: {
    type: "object",
    properties: {
      token: {
        type: "string",
        description: "Stock Token contract address (0x...) or ticker symbol, e.g. AAPL.",
      },
      purpose: {
        type: "string",
        enum: ["trade", "price"],
        default: "trade",
        description: "trade = execute a swap now; price = use it as a valuation.",
      },
    },
    required: ["token"],
  },
};

type JsonRpc = { jsonrpc: "2.0"; id?: string | number | null; method?: string; params?: unknown };

function send(msg: unknown): void {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

function reply(id: JsonRpc["id"], result: unknown): void {
  send({ jsonrpc: "2.0", id, result });
}

function fail(id: JsonRpc["id"], code: number, message: string): void {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

async function handle(msg: JsonRpc): Promise<void> {
  const { id, method, params } = msg;
  if (method === undefined) return; // a response, not a request

  switch (method) {
    case "initialize":
      reply(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: SERVER,
        instructions:
          "Ask `check` before you use a Stock Token price or trade one. It reports data " +
          "conditions (market closed, oracle/token paused, stale or diverging feed, pending " +
          "multiplier) and is not investment advice.",
      });
      return;

    case "notifications/initialized":
      return;

    case "tools/list":
      reply(id, { tools: [TOOL] });
      return;

    case "tools/call": {
      const p = (params ?? {}) as { name?: string; arguments?: { token?: string; purpose?: Purpose } };
      if (p.name !== "check") {
        fail(id, -32602, `unknown tool: ${p.name}`);
        return;
      }
      const token = p.arguments?.token;
      if (!token) {
        fail(id, -32602, "check requires `token`");
        return;
      }
      const purpose: Purpose = p.arguments?.purpose === "price" ? "price" : "trade";
      try {
        const r = await check(token, purpose);
        reply(id, {
          content: [{ type: "text", text: JSON.stringify(r, null, 2) }],
          isError: false,
        });
      } catch (e) {
        reply(id, {
          content: [{ type: "text", text: `error: ${(e as Error).message}` }],
          isError: true,
        });
      }
      return;
    }

    default:
      // Unknown notifications must not be answered; unknown requests get a standard error.
      if (id !== undefined && id !== null) fail(id, -32601, `method not found: ${method}`);
  }
}

function main(): void {
  // Fail early and visibly if the shipped data is missing, rather than at the first tool call.
  const feeds = loadFeeds();
  const cal = coverageLabel(
    JSON.parse(readFileSync(new URL("../calendar/nyse-holidays.json", import.meta.url), "utf8")),
  );
  process.stderr.write(
    `[stock-token-check] ${Object.keys(feeds).length} tokens, calendar covers ${cal}\n`);

  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on("line", (line) => {
    const text = line.trim();
    if (!text) return;
    let msg: JsonRpc;
    try {
      msg = JSON.parse(text) as JsonRpc;
    } catch {
      fail(null, -32700, "parse error");
      return;
    }
    void handle(msg).catch((e) => {
      process.stderr.write(`[stock-token-check] handler error: ${(e as Error).message}\n`);
      if (msg.id !== undefined) fail(msg.id, -32603, (e as Error).message);
    });
  });
  rl.on("close", () => process.exit(0));
}

main();
