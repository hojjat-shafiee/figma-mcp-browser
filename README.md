# Figma MCP Bridge Chrome Extension

An open-source Chromium extension that bridges Figma node data directly from an active browser tab to a local Model Context Protocol (MCP) server — **without a Figma REST API token or Personal Access Token (PAT)**.

Instead of hitting the REST API, this extension injects a script into the Figma page's MAIN JavaScript world and reads node data directly from `window.figma` — the same in-memory Plugin API that Figma plugins use. This gives you instant access to the live document tree: typography, fills, auto-layout, dimensions, and the full recursive child hierarchy.

---

## Features

- **No API Token Required** — No Figma PAT, no OAuth, no rate limits.
- **Full Node Tree** — Recursively serializes all children of a node: frames, text layers, images, vectors, and nested components.
- **Plugin API Access** — Reads from `window.figma` directly (same data source as Figma plugins), not the REST API.
- **WebSocket Bridge** — Connects to a local MCP server at `ws://127.0.0.1:9223` with automatic reconnect and exponential backoff.
- **Real-Time Selection Tracking** — Emits `SELECTION_CHANGED` events when you select a different layer in Figma.
- **Resilient Service Worker** — Keep-alive ports and alarm heartbeats prevent the MV3 service worker from being suspended.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  Figma Browser Tab (figma.com)                                              │
│                                                                             │
│  ┌───────────────┐   postMessage    ┌────────────────────────────────────┐  │
│  │  content.js   │ ◄──────────────► │  inject.js (MAIN world)            │  │
│  │ (ISOLATED)    │                  │  • window.figma Plugin API         │  │
│  │ • URL polling │                  │  • getNodeByIdAsync()              │  │
│  │ • keep-alive  │                  │  • currentPage.selection           │  │
│  └───────┬───────┘                  │  • recursive child traversal       │  │
│          │ chrome.tabs.sendMessage  └────────────────────────────────────┘  │
└──────────┼──────────────────────────────────────────────────────────────────┘
           │
┌──────────▼──────────┐    WebSocket     ┌──────────────────┐
│   background.js     │ ◄──────────────► │  server/index.js │ ◄── AI Client
│  (Service Worker)   │  ws://127.0.0.1  │  (MCP Server)    │     (Claude, etc.)
│  • chrome.scripting │  :9223           └──────────────────┘
│  • tab management   │
└─────────────────────┘
```

### Request Flow

1. AI client calls a tool (e.g. `get_figma_node`) via MCP.
2. MCP server sends a `GET_NODE_DATA` message to the background service worker over WebSocket.
3. Background injects `inject.js` into the Figma tab's **MAIN world** via `chrome.scripting.executeScript` (bypasses Figma's Content Security Policy).
4. Background sends a `FETCH_NODE_DATA` message to `content.js`.
5. `content.js` forwards it to `inject.js` via `window.postMessage`.
6. `inject.js` reads data from `window.figma` and serializes the full node tree recursively.
7. The response travels back: `inject.js` → `content.js` → `background.js` → MCP server → AI client.

---

## Installation

### 1. Download the Extension

Go to the [Releases page](../../releases/latest) and download:

- **`figma-mcp-bridge-{version}.zip`** — the Chrome extension
- **`figma-mcp-server-{version}.tar.gz`** — the local MCP server

Then load the extension in Chrome:

1. Unzip `figma-mcp-bridge-{version}.zip` into a local folder.
2. Open Chrome and go to `chrome://extensions/`.
3. Enable **Developer mode** (top-right toggle).
4. Click **Load unpacked** and select the unzipped folder.
5. The **Figma MCP Bridge** extension card will appear.

> **Alternatively**, clone the repository and load the root folder directly as an unpacked extension — useful if you want to modify the source.

### 2. Start the MCP Server

Extract `figma-mcp-server-{version}.tar.gz`, then:

```bash
nvm use 22
npm install
node index.js
```

The server listens on `ws://127.0.0.1:9223` for the extension and communicates via `stdio` with your AI client.

### 3. Register with Your AI Client

#### Claude Desktop
`~/Library/Application Support/Claude/claude_desktop_config.json` (macOS)  
`%APPDATA%\Claude\claude_desktop_config.json` (Windows)

```json
{
  "mcpServers": {
    "figma-browser-bridge": {
      "command": "node",
      "args": ["/absolute/path/to/server/index.js"]
    }
  }
}
```

#### Antigravity / Codex
```json
{
  "mcp": {
    "servers": {
      "figma-browser-bridge": {
        "command": "node",
        "args": ["/absolute/path/to/server/index.js"]
      }
    }
  }
}
```

---

## Usage

### Step 1 — Open a Figma Design Tab

Navigate to a Figma design file in Chrome (URL must contain `/design/`, `/file/`, or `/board/`). The extension auto-injects `inject.js` into the page's MAIN world as soon as the tab finishes loading.

### Step 2 — Register the Figma Object (One-Time Per Session)

Figma exposes its in-memory Plugin API via `window.figma`, but it initialises asynchronously after the editor boots. You need to hand it to the bridge once per session.

Open **DevTools** on the Figma tab (`F12` or `Cmd+Option+I`) and run:

```js
injectFigma(window.figma)
```

You will see this confirmation in the console:

```
[Figma MCP] figma object registered. Bridge is ready.
```

> **Why is this needed?**  
> Figma's `window.figma` object is only available after the editor fully initialises — not at page load time. The `injectFigma()` function is exposed by `inject.js` as a bridge hook so you can hand off the live figma instance once the editor is ready. This is a one-time step per tab session (after reload or navigation you repeat it).

### Step 3 — Use the MCP Tools

#### `get_figma_node`
Fetch the full node tree for a specific node ID.

```
fileKey  — the segment after /design/ in the Figma URL
nodeId   — the node ID (e.g. "474-11039" or "474:11039")
```

Extract both from the Figma URL:
```
https://www.figma.com/design/AbcFcJrZvvOf6LmK2P8t0W/My-File?node-id=474-11039
                              ┗━━━━━━ fileKey ━━━━━━━┛                ┗━ nodeId ━┛
```

#### `get_active_selection`
Fetch the node currently selected in the active Figma tab (no arguments needed). The extension tracks URL-based selection changes automatically via a 500ms poller.

---

## Output Format

Each node is serialized recursively, including all children:

```json
{
  "id": "482:9088",
  "name": "🟪 OUR PROJECTS",
  "type": "FRAME",
  "visible": true,
  "dimensions": {
    "width": 1440,
    "height": 1120,
    "absoluteBoundingBox": { "x": 2952, "y": -11704, "width": 1440, "height": 1120 }
  },
  "autoLayout": {
    "direction": "VERTICAL",
    "itemSpacing": 48,
    "padding": { "left": 100, "right": 100, "top": 116, "bottom": 116 }
  },
  "fills": [
    { "type": "SOLID", "visible": true, "opacity": 1, "color": { "r": 243, "g": 243, "b": 243, "a": 1 } }
  ],
  "textContext": null,
  "children": [
    {
      "id": "482:9090",
      "name": "so...what have we built?",
      "type": "TEXT",
      "visible": true,
      "textContext": {
        "characters": "so...what have we built?",
        "fontSize": 60,
        "fontFamily": "Anton",
        "fontWeight": "Regular"
      },
      "children": null
    }
  ]
}
```

**Fields:**
| Field | Description |
|---|---|
| `id` | Figma node ID (colon format) |
| `name` | Layer name as shown in the Figma layers panel |
| `type` | Node type: `FRAME`, `TEXT`, `RECTANGLE`, `VECTOR`, `LINE`, etc. |
| `visible` | `false` when the layer is hidden in the editor (eye icon off); `true` otherwise |
| `dimensions` | Width, height, and absolute canvas position |
| `autoLayout` | Direction, item spacing, and padding (null if not an auto-layout frame) |
| `fills` | Array of fill objects with type, color (RGB 0–255), opacity, and visibility |
| `textContext` | Text content, font size, font family, and weight (null for non-text nodes) |
| `children` | Recursively serialized child nodes (null for leaf nodes) |

---

## WebSocket Protocol

### Incoming: Fetch Node

```json
{
  "action": "GET_NODE_DATA",
  "requestId": "req_1716912345_1",
  "fileKey": "AbcFcJrZvvOf6LmK2P8t0W",
  "nodeId": "474-11039",
  "fetchSelection": false
}
```

Set `fetchSelection: true` to read the active in-editor selection instead of a specific node ID.

### Outgoing: Node Response

```json
{
  "requestId": "req_1716912345_1",
  "timestamp": 1716912345678,
  "success": true,
  "data": { ... }
}
```

### Outgoing: Selection Change Broadcast

```json
{
  "event": "SELECTION_CHANGED",
  "fileKey": "AbcFcJrZvvOf6LmK2P8t0W",
  "nodeId": "474:11039",
  "timestamp": 1716912345790
}
```

---

## Troubleshooting

| Problem | Solution |
|---|---|
| `injectFigma is not defined` | The extension wasn't loaded yet or the Figma tab wasn't refreshed after loading the extension. Hard-refresh the Figma tab (`Ctrl+Shift+R`) and wait for the editor to fully load. |
| `[Figma MCP] figma object registered` but requests still fail | The WebSocket connection to the MCP server may be down. Make sure `npm start` is running in the `server/` directory. |
| Request timeout (10s) | The bridge is connected but `window.figma` was not registered. Run `injectFigma(window.figma)` in the DevTools console. |
| Node not found | The node ID doesn't exist in the currently open Figma file. Check that the fileKey in your request matches the file open in the browser tab. |
| Service worker suspended | Chrome MV3 service workers go idle after ~30s of inactivity. Selecting a layer in Figma wakes the worker immediately via the content script keep-alive. |

---

## License

This project is licensed under the [MIT License](LICENSE).
