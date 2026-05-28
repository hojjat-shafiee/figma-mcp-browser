(function() {
  console.log("[Figma MCP Main] Script injected into main world context.");

  // 0. Locate the figma object — it may live on the top-level window, inside a
  //    same-origin iframe (where the Figma editor canvas runs), or it may have
  //    been manually registered via window.__figmaMCPRegister() from DevTools.
  function findFigma() {
    // Priority 1: top-level window
    if (window.figma) return window.figma;

    // Priority 2: manually registered instance (DevTools fallback)
    if (window.__figmaMCPInstance) return window.__figmaMCPInstance;

    // Priority 3: scan same-origin iframes (Figma editor runs in an iframe)
    const frames = document.querySelectorAll("iframe");
    for (const frame of frames) {
      try {
        const fw = frame.contentWindow;
        if (fw && fw.figma) return fw.figma;
      } catch (_) {
        // Cross-origin frame — skip silently
      }
    }

    return null;
  }

  // DevTools registration hook. In the Figma tab console, run:
  //   injectFigma(window.figma)
  window.injectFigma = function(figmaObj) {
    window.__figmaMCPInstance = figmaObj;
    console.log("[Figma MCP] figma object registered. Bridge is ready.");
  };

  function waitForFigma(timeoutMs = 8000) {
    return new Promise((resolve, reject) => {
      const found = findFigma();
      if (found) return resolve(found);
      const interval = 100;
      let elapsed = 0;
      const timer = setInterval(() => {
        const f = findFigma();
        if (f) {
          clearInterval(timer);
          return resolve(f);
        }
        elapsed += interval;
        if (elapsed >= timeoutMs) {
          clearInterval(timer);
          reject(new Error(
            "Timed out waiting for window.figma (checked top-level window, iframes, and manual registration). " +
            "If you can see figma in DevTools, run: window.top.__figmaMCPRegister(figma)"
          ));
        }
      }, interval);
    });
  }

  // 1. Serialization Helpers
  function serializeFills(fills, figma) {
    if (!fills || fills === figma.mixed) return [];
    return fills.map(fill => {
      const serialized = {
        type: fill.type,
        visible: fill.visible !== false
      };
      if (fill.opacity !== undefined) {
        serialized.opacity = fill.opacity;
      }
      if (fill.color) {
        serialized.color = {
          r: Math.round(fill.color.r * 255),
          g: Math.round(fill.color.g * 255),
          b: Math.round(fill.color.b * 255),
          a: fill.opacity !== undefined ? fill.opacity : 1
        };
      }
      return serialized;
    });
  }

  function getDimensions(node) {
    const box = node.absoluteBoundingBox;
    if (box) {
      return {
        width: box.width,
        height: box.height,
        absoluteBoundingBox: {
          x: box.x,
          y: box.y,
          width: box.width,
          height: box.height
        }
      };
    }
    return {
      width: node.width ?? 0,
      height: node.height ?? 0,
      absoluteBoundingBox: {
        x: node.x ?? 0,
        y: node.y ?? 0,
        width: node.width ?? 0,
        height: node.height ?? 0
      }
    };
  }

  function getAutoLayout(node) {
    if (node.layoutMode && node.layoutMode !== "NONE") {
      return {
        direction: node.layoutMode,
        itemSpacing: node.itemSpacing ?? 0,
        padding: {
          left: node.paddingLeft ?? 0,
          right: node.paddingRight ?? 0,
          top: node.paddingTop ?? 0,
          bottom: node.paddingBottom ?? 0
        }
      };
    }
    return null;
  }

  function getTextContext(node, figma) {
    if (node.type === "TEXT") {
      let fontFamily = null;
      let fontWeight = null;

      if (node.fontName && node.fontName !== figma.mixed) {
        fontFamily = node.fontName.family || null;
        fontWeight = node.fontName.style || null;
      }

      return {
        characters: node.characters ?? "",
        fontSize: node.fontSize !== figma.mixed ? (node.fontSize ?? null) : null,
        fontFamily,
        fontWeight
      };
    }
    return null;
  }

  function normalizePluginNode(node, figma) {
    if (!node) return null;

    const result = {
      id: node.id,
      name: node.name,
      type: node.type,
      // false only when the layer is explicitly hidden in the editor (eye icon off).
      // Defaults to true when the property is absent (e.g. page root nodes).
      visible: node.visible !== false,
      dimensions: getDimensions(node),
      autoLayout: getAutoLayout(node),
      fills: serializeFills(node.fills, figma),
      textContext: getTextContext(node, figma),
      children: null
    };

    if (node.children && node.children.length > 0) {
      result.children = node.children.map(child => normalizePluginNode(child, figma));
    }

    return result;
  }

  // 2. Node Query Handlers
  async function queryNodeById(nodeId) {
    const figma = await waitForFigma();

    // Figma IDs internally use colon format (e.g. 216:8485)
    const normalizedNodeId = nodeId.replace(/-/g, ":");

    let node = null;
    if (typeof figma.getNodeByIdAsync === "function") {
      node = await figma.getNodeByIdAsync(normalizedNodeId);
    } else if (typeof figma.getNodeById === "function") {
      node = figma.getNodeById(normalizedNodeId);
    }

    if (!node) {
      throw new Error(`Node ID '${nodeId}' not found in the current Figma document.`);
    }

    return normalizePluginNode(node, figma);
  }

  async function queryActiveSelection() {
    const figma = await waitForFigma();

    const selection = figma.currentPage.selection;
    if (!selection || selection.length === 0) {
      throw new Error("No layers are currently selected in the active Figma tab.");
    }

    return normalizePluginNode(selection[0], figma);
  }

  // 3. Message Listener
  window.addEventListener("message", async (event) => {
    if (event.source !== window) return;
    
    const msg = event.data;
    if (msg && msg.source === "figma-mcp-isolated") {
      if (msg.action === "FETCH_NODE_DATA") {
        const { requestId, nodeId, fetchSelection } = msg;
        try {
          let data;
          if (fetchSelection) {
            data = queryActiveSelection();
          } else {
            data = await queryNodeById(nodeId);
          }
          
          window.postMessage({
            source: "figma-mcp-main",
            action: "FETCH_NODE_DATA_RESPONSE",
            requestId,
            response: { success: true, data }
          }, "*");
        } catch (error) {
          console.error("[Figma MCP Main] Error processing request:", error);
          window.postMessage({
            source: "figma-mcp-main",
            action: "FETCH_NODE_DATA_RESPONSE",
            requestId,
            response: { success: false, error: error.message }
          }, "*");
        }
      }
    }
  });
})();
