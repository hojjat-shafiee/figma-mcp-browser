import { spawn } from "child_process";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SCRIPT_PATH = path.join(__dirname, "session_sync.py");

/**
 * Execute session_sync.py with specified flags and return parsed JSON
 */
function runSessionSync(args = []) {
  return new Promise((resolve, reject) => {
    const pythonExe = process.env.PYTHON_PATH || "python";
    const proc = spawn(pythonExe, [SCRIPT_PATH, "--json", ...args], {
      windowsHide: true
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    proc.on("close", (code) => {
      if (code !== 0) {
        return reject(new Error(stderr.trim() || `Session sync failed with exit code ${code}`));
      }
      try {
        const parsed = JSON.parse(stdout.trim());
        resolve(parsed);
      } catch (err) {
        reject(new Error(`Failed to parse session sync output: ${stdout || stderr}`));
      }
    });

    proc.on("error", (err) => {
      reject(new Error(`Failed to start python process: ${err.message}`));
    });
  });
}

/**
 * Get active Figma session metadata from last completed login
 */
export async function getFigmaSessionStatus() {
  const result = await runSessionSync(["--status"]);
  if (!result.success) {
    throw new Error(result.error || "Unable to retrieve Figma session status");
  }
  return result.metadata;
}

/**
 * Sync active Figma session cookies into MCP Chrome Profile
 */
export async function syncFigmaSessionToBrowser() {
  const result = await runSessionSync(["--sync-mcp"]);
  if (!result.success) {
    throw new Error(result.error || "Unable to sync Figma session cookies to browser");
  }
  return result.metadata;
}

