/**
 * Figma MCP Bridge - Content Script
 * Executes inside figma.com tabs. Handles script injection, polls URL selection
 * changes, and proxies node query requests to the MAIN world script (inject.js).
 */

// 1. Maintain Keep-Alive connection to the service worker
let keepAlivePort = null;
function connectKeepAlive() {
  try {
    keepAlivePort = chrome.runtime.connect({ name: "figma-keep-alive" });
    keepAlivePort.onDisconnect.addListener(() => {
      console.log("[Figma MCP Content] Keep-alive port disconnected. Reconnecting...");
      setTimeout(connectKeepAlive, 1000);
    });
  } catch (err) {
    // Service worker might be offline or starting up
    setTimeout(connectKeepAlive, 2000);
  }
}
connectKeepAlive();

// 2. URL Parsing Utility
function parseCurrentUrl() {
  try {
    const url = new URL(window.location.href);
    const pathParts = url.pathname.split('/');
    
    let fileKey = null;
    const designIdx = pathParts.indexOf('design');
    const fileIdx = pathParts.indexOf('file');
    const boardIdx = pathParts.indexOf('board');
    
    if (designIdx !== -1 && designIdx + 1 < pathParts.length) {
      fileKey = pathParts[designIdx + 1];
    } else if (fileIdx !== -1 && fileIdx + 1 < pathParts.length) {
      fileKey = pathParts[fileIdx + 1];
    } else if (boardIdx !== -1 && boardIdx + 1 < pathParts.length) {
      fileKey = pathParts[boardIdx + 1];
    }
    
    const nodeIdParam = url.searchParams.get('node-id');
    const nodeId = nodeIdParam ? nodeIdParam.replace(/-/g, ':') : null;
    
    return { fileKey, nodeId };
  } catch (e) {
    console.error("[Figma MCP Content] Error parsing URL:", e);
    return { fileKey: null, nodeId: null };
  }
}

// 3. Selection Tracking Poller
let lastFileKey = null;
let lastNodeId = null;

function pollSelectionChanges() {
  const { fileKey, nodeId } = parseCurrentUrl();
  
  if (fileKey !== lastFileKey || nodeId !== lastNodeId) {
    lastFileKey = fileKey;
    lastNodeId = nodeId;
    
    if (fileKey && nodeId) {
      console.log(`[Figma MCP Content] Selection change detected. File: ${fileKey}, Node: ${nodeId}`);
      try {
        chrome.runtime.sendMessage({
          action: "SELECTION_CHANGED",
          fileKey,
          nodeId
        }, () => {
          if (chrome.runtime.lastError) {
            // Suppress errors when worker is asleep
          }
        });
      } catch (err) {
        // Suppress extension context invalidation errors
      }
    }
  }
}

// Poll URL changes every 500ms
setInterval(pollSelectionChanges, 500);
window.addEventListener("popstate", pollSelectionChanges);

// 4. MAIN World Message Bridge
const pendingCallbacks = new Map();

window.addEventListener("message", (event) => {
  if (event.source !== window) return;
  
  const msg = event.data;
  if (msg && msg.source === "figma-mcp-main") {
    if (msg.action === "FETCH_NODE_DATA_RESPONSE") {
      const callback = pendingCallbacks.get(msg.requestId);
      if (callback) {
        pendingCallbacks.delete(msg.requestId);
        callback(msg.response);
      }
    }
  }
});

// Helper to query inject.js
function executeFetch(fileKey, nodeId, fetchSelection, sendResponse) {
  try {
    const requestId = Math.random().toString(36).substring(2, 15);
    pendingCallbacks.set(requestId, sendResponse);
    
    window.postMessage({
      source: "figma-mcp-isolated",
      action: "FETCH_NODE_DATA",
      requestId,
      fileKey,
      nodeId,
      fetchSelection
    }, "*");
  } catch (error) {
    console.error("[Figma MCP Content] Message dispatch to MAIN world failed:", error);
    sendResponse({ success: false, error: error.message });
  }
}

// 5. Message listener from Background Service Worker
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "FETCH_NODE_DATA") {
    const fetchSelection = request.fetchSelection || false;
    const fileKey = request.fileKey || lastFileKey;
    const nodeId = request.nodeId || lastNodeId;

    if (fetchSelection) {
      executeFetch(fileKey, null, true, sendResponse);
    } else if (!fileKey || !nodeId) {
      const current = parseCurrentUrl();
      const finalFileKey = fileKey || current.fileKey;
      const finalNodeId = nodeId || current.nodeId;

      if (!finalFileKey || !finalNodeId) {
        sendResponse({ success: false, error: "Could not resolve fileKey or nodeId from active tab." });
        return true;
      }
      
      executeFetch(finalFileKey, finalNodeId, false, sendResponse);
    } else {
      executeFetch(fileKey, nodeId, false, sendResponse);
    }
    return true; // Keep message channel open for asynchronous response
  }
});

// Initial Selection Run
pollSelectionChanges();
