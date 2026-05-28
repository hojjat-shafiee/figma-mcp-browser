/**
 * Figma MCP Bridge - Local Node.js MCP Server
 * Exposes MCP tools over standard I/O (stdio) to AI clients (Claude, Antigravity, Codex)
 * and bridges queries to the browser extension via a local WebSocket connection.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { WebSocketServer } from "ws";

// Local port for the browser extension to connect to
const WEBSOCKET_PORT = 9223;

// Bridge State
let extensionSocket = null;
let lastSelection = null;
let requestCounter = 0;
const pendingRequests = new Map();

// 1. Initialize WebSocket Server (Explicitly bind to IPv4 loopback)
const wss = new WebSocketServer({ port: WEBSOCKET_PORT, host: "127.0.0.1" });
console.error(`[MCP Bridge] WebSocket Server starting on ws://127.0.0.1:${WEBSOCKET_PORT}...`);

wss.on("connection", (ws) => {
  console.error("[MCP Bridge] Browser extension connected.");
  extensionSocket = ws;

  ws.on("message", (data) => {
    try {
      const msg = JSON.parse(data.toString());
      
      // Handle heartbeats
      if (msg.event === "PING") {
        ws.send(JSON.stringify({ event: "PONG" }));
        return;
      }

      // Handle real-time selection updates broadcasted by content script
      if (msg.event === "SELECTION_CHANGED") {
        lastSelection = {
          fileKey: msg.fileKey,
          nodeId: msg.nodeId,
          timestamp: msg.timestamp || Date.now()
        };
        console.error(`[MCP Bridge] Selection update received: File=${msg.fileKey}, Node=${msg.nodeId}`);
        return;
      }

      // Handle response to a pending node query
      if (msg.requestId && pendingRequests.has(msg.requestId)) {
        const { resolve, reject, timeout } = pendingRequests.get(msg.requestId);
        clearTimeout(timeout);
        pendingRequests.delete(msg.requestId);

        if (msg.success) {
          resolve(msg.data);
        } else {
          reject(new Error(msg.error || "Unknown extension query error"));
        }
      }
    } catch (err) {
      console.error("[MCP Bridge] Error parsing WebSocket message:", err);
    }
  });

  ws.on("close", () => {
    console.error("[MCP Bridge] Browser extension disconnected.");
    if (extensionSocket === ws) {
      extensionSocket = null;
    }
  });

  ws.on("error", (error) => {
    console.error("[MCP Bridge] WebSocket client error:", error);
  });
});

// 2. Initialize MCP Server
const mcpServer = new Server(
  {
    name: "figma-browser-bridge",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Define tool listings
mcpServer.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "get_figma_node",
        description: "Retrieve Figma node layout, geometry, typography, and fill data directly from the active browser tab without an API token.",
        inputSchema: {
          type: "object",
          properties: {
            fileKey: {
              type: "string",
              description: "The unique Figma file key from the URL (/design/FILE_KEY/...)",
            },
            nodeId: {
              type: "string",
              description: "The targeted Figma node/layer ID (e.g. '474:10679' or '474-10679')",
            },
          },
          required: ["fileKey", "nodeId"],
        },
      },
      {
        name: "get_active_selection",
        description: "Retrieve figma design node details for the layer currently selected by the user in their active Figma browser tab.",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
    ],
  };
});

// Helper to query the browser extension via WebSocket
function queryExtension(fileKey, nodeId, fetchSelection = false) {
  if (!extensionSocket || extensionSocket.readyState !== 1) { // 1 = OPEN
    throw new Error("No active browser extension connection. Please make sure Google Chrome is open, has a Figma tab loaded, and the extension is active.");
  }

  const requestId = `req_${Date.now()}_${++requestCounter}`;
  
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingRequests.delete(requestId);
      reject(new Error(`Figma extension request timeout after 10s (Target: File=${fileKey}, Node=${nodeId})`));
    }, 10000);

    pendingRequests.set(requestId, { resolve, reject, timeout });

    // Send query payload to extension
    extensionSocket.send(
      JSON.stringify({
        action: "GET_NODE_DATA",
        requestId,
        fileKey,
        nodeId,
        fetchSelection
      })
    );
  });
}

// Define tool executions
mcpServer.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    if (name === "get_figma_node") {
      const { fileKey, nodeId } = args;
      if (!fileKey || !nodeId) {
        throw new Error("Missing required arguments: fileKey and nodeId.");
      }

      console.error(`[MCP Bridge] Tool Call: get_figma_node (File=${fileKey}, Node=${nodeId})`);
      const nodeData = await queryExtension(fileKey, nodeId, false);
      
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(nodeData, null, 2),
          },
        ],
      };
    } else if (name === "get_active_selection") {
      console.error("[MCP Bridge] Tool Call: get_active_selection");
      
      let fileKey = null;
      let nodeId = null;
      let fetchSelection = true;
      
      if (lastSelection) {
        fileKey = lastSelection.fileKey;
        nodeId = lastSelection.nodeId;
        fetchSelection = false;
        console.error(`[MCP Bridge] Active Selection mapped to File=${fileKey}, Node=${nodeId}`);
      } else {
        console.error("[MCP Bridge] No selection tracked yet. Querying active tab selection dynamically...");
      }
      
      const nodeData = await queryExtension(fileKey, nodeId, fetchSelection);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                mcpSelectionContext: {
                  fileKey: fileKey || (nodeData ? nodeData.fileKey : null),
                  nodeId: nodeId || (nodeData ? nodeData.id : null),
                  trackedAt: lastSelection ? new Date(lastSelection.timestamp).toISOString() : new Date().toISOString(),
                },
                nodeData,
              },
              null,
              2
            ),
          },
        ],
      };
    } else {
      throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    console.error(`[MCP Bridge] Error executing tool '${name}':`, error.message);
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: `Error: ${error.message}`,
        },
      ],
    };
  }
});

// 3. Connect to Stdio Transport
async function runServer() {
  const transport = new StdioServerTransport();
  await mcpServer.connect(transport);
  console.error("[MCP Bridge] Bridge MCP Server connected to stdio transport successfully.");
}

runServer().catch((error) => {
  console.error("[MCP Bridge] Fatal error running MCP Server:", error);
  process.exit(1);
});
