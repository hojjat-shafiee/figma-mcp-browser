---
name: figma-mcp-debug
description: >-
  Diagnostic and troubleshooting runbook for the Figma MCP Bridge.
  Use when diagnosing WebSocket connection issues, script injection failures,
  Figma node query timeouts, or session synchronization errors.
---

# Figma MCP Bridge Diagnostic Runbook

Follow these step-by-step diagnostic workflows to troubleshoot and verify each hop of the Figma MCP Bridge.

---

## 1. Verify MCP Server & WebSocket Listener

Check if the local MCP server starts and binds to port `9223`:

```powershell
# Run the server test in PowerShell
node server/index.js
```

**Expected output on stderr**:
```text
[MCP Bridge] WebSocket Server starting on ws://127.0.0.1:9223...
[MCP Bridge] Bridge MCP Server connected to stdio transport successfully.
```

**Validation**:
- Ensure port 9223 is listening:
  ```powershell
  Test-NetConnection -ComputerName 127.0.0.1 -Port 9223
  ```
  `TcpTestSucceeded` should be `True`.

---

## 2. Check Figma Session Status

Verify that a valid authenticated Figma login is detected on the local system:

```powershell
npm run session-status
# or:
python server/session_sync.py --status
```

**Checks**:
- Is `session_valid: true`?
- Is `user_id` populated?
- Is the cookie expiration timestamp in the future?

If cookies are locked or the session is expired:
1. Open Figma Desktop or Chrome.
2. Log into Figma.
3. Run `npm run sync-session` to push active cookies to the MCP browser profile.

---

## 3. Diagnose Browser Extension Status

1. Open Chrome and navigate to `chrome://extensions`.
2. Find **Figma MCP Bridge**.
3. Check the **Service Worker** link:
   - If it says `Inactive`, click the service worker link to open the DevTools inspector.
   - Look for:
     ```text
     [Figma MCP] Connecting to WebSocket at ws://127.0.0.1:9223...
     [Figma MCP] WebSocket connection established successfully.
     ```
   - If connection failed, verify `node server/index.js` is running.

---

## 4. Diagnose Figma Tab & Script Injection

1. Open a Figma design file in Chrome (e.g. `https://www.figma.com/design/...`).
2. Open the browser DevTools Console (`F12`).
3. Check for the injection banner:
   ```text
   [Figma MCP Main] Script injected into main world context.
   ```
4. Check if `window.figma` is accessible:
   - Run `window.figma` in the console.
   - If `undefined` (because canvas runs in an iframe):
     - Select the canvas iframe context in the DevTools console dropdown, or run:
       ```javascript
       window.top.injectFigma(figma)
       ```
     - You should see:
       ```text
       [Figma MCP] figma object registered. Bridge is ready.
       ```

---

## 5. Trace a Live Query Request

From the AI client (or using a mock WebSocket client), trigger a node query:
```json
{
  "action": "GET_NODE_DATA",
  "requestId": "test_req_1",
  "fetchSelection": true
}
```

Check the log sequence:
1. `server/index.js` receives tool call and sends WebSocket payload to extension.
2. `background.js` logs `Dispatching query to tab ID: ...`.
3. `content.js` receives `FETCH_NODE_DATA` and dispatches `postMessage` to `inject.js`.
4. `inject.js` reads `figma.currentPage.selection` and returns normalized node data.
5. Response flows back through WebSocket to MCP server.
