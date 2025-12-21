import express from "express";
import cors from "cors";
import { WebSocketServer } from "ws";
import pty from "node-pty";
import fs from "fs/promises";
import path from "path";
import http from "http";
import os from "os";

/* ================= CONFIG ================= */
const PORT = process.env.PORT || 3001;

// Déterminer le WORKDIR : parent du dossier .codespace-agent
async function determineWorkdir() {
  if (process.env.WORKDIR) {
    return process.env.WORKDIR;
  }
  
  const cwd = process.cwd();
  
  // Si on est dans le dossier .codespace-agent, prendre le parent
  if (cwd.endsWith('.codespace-agent') || path.basename(cwd) === '.codespace-agent') {
    return path.dirname(cwd);
  }
  
  // Sinon, chercher le dossier .codespace-agent
  const codespaceDir = path.join(cwd, '.codespace-agent');
  try {
    await fs.access(codespaceDir);
    // .codespace-agent existe, donc cwd est le parent
    return cwd;
  } catch {
    // .codespace-agent n'existe pas, utiliser le répertoire courant
    return cwd;
  }
}

const WORKDIR = await determineWorkdir();
const AGENT_TOKEN = process.env.AGENT_TOKEN || 'secrets';
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
const ALLOWED_EXTENSIONS = process.env.ALLOWED_EXTENSIONS?.split(',') || null;

if (!AGENT_TOKEN) {
  console.error("❌ AGENT_TOKEN is required");
  process.exit(1);
}

console.log(`📁 Working directory: ${WORKDIR}`);
console.log(`🔒 Authentication: enabled`);

/* ================= UTILS ================= */

/**
 * Vérifie l'authentification Bearer token
 */
function assertAuth(req, res) {
  const auth = req.headers.authorization;
  if (!auth || auth !== `Bearer ${AGENT_TOKEN}`) {
    res.status(401).json({ error: "Unauthorized" });
    return false;
  }
  return true;
}

/**
 * Sécurise les chemins de fichiers pour éviter les directory traversal attacks
 */
function safePath(p) {
  if (!p) {
    throw new Error("Path is required");
  }
  const resolved = path.resolve(WORKDIR, p);
  if (!resolved.startsWith(WORKDIR)) {
    throw new Error("Invalid path: outside working directory");
  }
  return resolved;
}

/**
 * Vérifie si un fichier existe
 */
async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Obtient des informations sur un fichier/dossier
 */
async function getFileStats(filePath) {
  try {
    const stats = await fs.stat(filePath);
    return {
      size: stats.size,
      isDirectory: stats.isDirectory(),
      isFile: stats.isFile(),
      modified: stats.mtime,
      created: stats.birthtime,
      permissions: stats.mode
    };
  } catch {
    return null;
  }
}

/**
 * Vérifie l'extension du fichier si ALLOWED_EXTENSIONS est défini
 */
function isAllowedExtension(filePath) {
  if (!ALLOWED_EXTENSIONS) return true;
  const ext = path.extname(filePath).toLowerCase();
  return ALLOWED_EXTENSIONS.includes(ext) || ALLOWED_EXTENSIONS.includes(ext.slice(1));
}

/* ================= HTTP API ================= */
const app = express();

app.use(cors({
  origin: process.env.CORS_ORIGIN || '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json({ limit: "10mb" }));

// Logging middleware
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.url}`);
  next();
});

/* ---- HEALTH CHECK ---- */
app.get("/health", (_, res) => {
  res.json({ 
    status: "ok",
    uptime: process.uptime(),
    workdir: WORKDIR,
    platform: os.platform(),
    nodeVersion: process.version
  });
});

/* ---- READ FILE ---- */
app.get("/api/files", async (req, res) => {
  if (!assertAuth(req, res)) return;
  
  try {
    const filePath = safePath(req.query.path);
    
    // Vérifier si le fichier existe
    if (!(await fileExists(filePath))) {
      return res.status(404).json({ error: "File not found" });
    }

    const stats = await getFileStats(filePath);
    
    // Vérifier si c'est un fichier
    if (stats.isDirectory) {
      return res.status(400).json({ error: "Path is a directory, not a file" });
    }

    // Vérifier la taille du fichier
    if (stats.size > MAX_FILE_SIZE) {
      return res.status(413).json({ 
        error: `File too large (max ${MAX_FILE_SIZE / 1024 / 1024}MB)`,
        size: stats.size
      });
    }

    const content = await fs.readFile(filePath, "utf8");
    res.json({ 
      path: req.query.path, 
      content,
      stats
    });
  } catch (e) {
    console.error("Error reading file:", e);
    res.status(400).json({ error: e.message });
  }
});

/* ---- WRITE FILE ---- */
app.post("/api/files", async (req, res) => {
  if (!assertAuth(req, res)) return;
  
  try {
    const { path: file, content, createDirs = true } = req.body;
    
    if (!file || content === undefined) {
      return res.status(400).json({ error: "Path and content are required" });
    }

    const filePath = safePath(file);

    // Vérifier l'extension si nécessaire
    if (!isAllowedExtension(filePath)) {
      return res.status(403).json({ 
        error: "File extension not allowed",
        allowed: ALLOWED_EXTENSIONS 
      });
    }

    // Créer les dossiers parents si nécessaire
    if (createDirs) {
      await fs.mkdir(path.dirname(filePath), { recursive: true });
    }

    await fs.writeFile(filePath, content, "utf8");
    
    const stats = await getFileStats(filePath);
    res.json({ 
      success: true, 
      path: file,
      stats
    });
  } catch (e) {
    console.error("Error writing file:", e);
    res.status(400).json({ error: e.message });
  }
});

/* ---- UPDATE FILE (PUT) ---- */
app.put("/api/files", async (req, res) => {
  if (!assertAuth(req, res)) return;
  
  try {
    const { path: file, content } = req.body;
    
    if (!file || content === undefined) {
      return res.status(400).json({ error: "Path and content are required" });
    }

    const filePath = safePath(file);

    // Vérifier si le fichier existe
    if (!(await fileExists(filePath))) {
      return res.status(404).json({ error: "File not found" });
    }

    await fs.writeFile(filePath, content, "utf8");
    
    const stats = await getFileStats(filePath);
    res.json({ 
      success: true, 
      path: file,
      stats
    });
  } catch (e) {
    console.error("Error updating file:", e);
    res.status(400).json({ error: e.message });
  }
});

/* ---- DELETE FILE ---- */
app.delete("/api/files", async (req, res) => {
  if (!assertAuth(req, res)) return;
  
  try {
    const filePath = safePath(req.query.path);
    
    if (!(await fileExists(filePath))) {
      return res.status(404).json({ error: "File not found" });
    }

    const stats = await getFileStats(filePath);
    
    if (stats.isDirectory) {
      await fs.rm(filePath, { recursive: req.query.recursive === 'true', force: true });
    } else {
      await fs.unlink(filePath);
    }
    
    res.json({ 
      success: true, 
      path: req.query.path,
      deleted: true
    });
  } catch (e) {
    console.error("Error deleting file:", e);
    res.status(400).json({ error: e.message });
  }
});

/* ---- LIST DIR ---- */
app.get("/api/ls", async (req, res) => {
  if (!assertAuth(req, res)) return;
  
  try {
    const dirPath = safePath(req.query.path || ".");
    
    if (!(await fileExists(dirPath))) {
      return res.status(404).json({ error: "Directory not found" });
    }

    const stats = await getFileStats(dirPath);
    if (!stats.isDirectory) {
      return res.status(400).json({ error: "Path is not a directory" });
    }

    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    const detailed = req.query.detailed === 'true';
    
    const result = {
      path: req.query.path || ".",
      entries: []
    };

    for (const entry of entries) {
      const entryPath = path.join(dirPath, entry.name);
      const item = {
        name: entry.name,
        type: entry.isDirectory() ? "dir" : "file"
      };

      if (detailed) {
        const entryStats = await getFileStats(entryPath);
        if (entryStats) {
          item.size = entryStats.size;
          item.modified = entryStats.modified;
        }
      }

      result.entries.push(item);
    }

    res.json(result);
  } catch (e) {
    console.error("Error listing directory:", e);
    res.status(400).json({ error: e.message });
  }
});

/* ---- CREATE DIRECTORY ---- */
app.post("/api/mkdir", async (req, res) => {
  if (!assertAuth(req, res)) return;
  
  try {
    const { path: dir, recursive = true } = req.body;
    
    if (!dir) {
      return res.status(400).json({ error: "Path is required" });
    }

    const dirPath = safePath(dir);
    await fs.mkdir(dirPath, { recursive });
    
    res.json({ 
      success: true, 
      path: dir 
    });
  } catch (e) {
    console.error("Error creating directory:", e);
    res.status(400).json({ error: e.message });
  }
});

/* ---- FILE/DIR INFO ---- */
app.get("/api/stat", async (req, res) => {
  if (!assertAuth(req, res)) return;
  
  try {
    const filePath = safePath(req.query.path);
    
    if (!(await fileExists(filePath))) {
      return res.status(404).json({ error: "Path not found" });
    }

    const stats = await getFileStats(filePath);
    res.json({ 
      path: req.query.path,
      stats
    });
  } catch (e) {
    console.error("Error getting stats:", e);
    res.status(400).json({ error: e.message });
  }
});

/* ---- SEARCH FILES ---- */
app.get("/api/search", async (req, res) => {
  if (!assertAuth(req, res)) return;
  
  try {
    const { query, path: searchPath = "." } = req.query;
    
    if (!query) {
      return res.status(400).json({ error: "Query is required" });
    }

    const dirPath = safePath(searchPath);
    const results = [];

    async function searchRecursive(dir, maxDepth = 5, currentDepth = 0) {
      if (currentDepth > maxDepth) return;
      
      try {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        
        for (const entry of entries) {
          if (entry.name.toLowerCase().includes(query.toLowerCase())) {
            const relativePath = path.relative(WORKDIR, path.join(dir, entry.name));
            results.push({
              name: entry.name,
              path: relativePath,
              type: entry.isDirectory() ? "dir" : "file"
            });
          }
          
          if (entry.isDirectory() && !entry.name.startsWith('.')) {
            await searchRecursive(path.join(dir, entry.name), maxDepth, currentDepth + 1);
          }
        }
      } catch (e) {
        // Ignorer les erreurs de permission
      }
    }

    await searchRecursive(dirPath);
    
    res.json({ 
      query,
      results,
      count: results.length
    });
  } catch (e) {
    console.error("Error searching:", e);
    res.status(400).json({ error: e.message });
  }
});

/* ================= TERMINAL WS ================= */
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

// Stocker les shells actifs
const activeSessions = new Map();

wss.on("connection", (ws, req) => {
  const sessionId = Math.random().toString(36).substring(7);
  console.log(`🔌 Terminal session started: ${sessionId}`);

  const shell = pty.spawn(process.platform === 'win32' ? 'powershell.exe' : 'bash', [], {
    cwd: WORKDIR,
    env: { ...process.env, TERM: 'xterm-256color' },
    cols: 80,
    rows: 30
  });

  activeSessions.set(sessionId, shell);

  shell.onData(data => {
    try {
      if (ws.readyState === ws.OPEN) {
        ws.send(data);
      }
    } catch (e) {
      console.error("Error sending terminal data:", e);
    }
  });

  shell.onExit(({ exitCode, signal }) => {
    console.log(`⚠️ Shell exited (code: ${exitCode}, signal: ${signal})`);
    try {
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({ 
          type: 'exit', 
          exitCode, 
          signal 
        }));
        ws.close();
      }
    } catch (e) {
      console.error("Error handling shell exit:", e);
    }
    activeSessions.delete(sessionId);
  });

  ws.on("message", msg => {
    try {
      const text = msg.toString();
      
      // Gérer les messages JSON (commandes de contrôle)
      if (text.startsWith("{")) {
        const json = JSON.parse(text);
        
        if (json.type === "resize") {
          shell.resize(json.cols || 80, json.rows || 30);
        } else if (json.type === "ping") {
          ws.send(JSON.stringify({ type: "pong" }));
        }
      } else {
        // Envoyer le texte au shell
        shell.write(text);
      }
    } catch (e) {
      console.error("Error processing terminal message:", e);
    }
  });

  ws.on("close", () => {
    console.log(`🔌 Terminal session closed: ${sessionId}`);
    try {
      shell.kill();
    } catch (e) {
      console.error("Error killing shell:", e);
    }
    activeSessions.delete(sessionId);
  });

  ws.on("error", (error) => {
    console.error(`WebSocket error for session ${sessionId}:`, error);
  });

  // Envoyer un message de bienvenue
  ws.send(JSON.stringify({ 
    type: 'connected', 
    sessionId,
    cwd: WORKDIR,
    platform: os.platform()
  }));
});

/* ---- WS AUTH + ROUTING ---- */
server.on("upgrade", (req, socket, head) => {
  const auth = req.headers.authorization;
  
  if (auth !== `Bearer ${AGENT_TOKEN}`) {
    console.warn("⚠️ Unauthorized WebSocket connection attempt");
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }

  if (req.url === "/ws/terminal") {
    wss.handleUpgrade(req, socket, head, ws => {
      wss.emit("connection", ws, req);
    });
  } else {
    console.warn(`⚠️ Unknown WebSocket path: ${req.url}`);
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
  }
});

/* ================= ERROR HANDLING ================= */
process.on('uncaughtException', (error) => {
  console.error('❌ Uncaught Exception:', error);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('📴 SIGTERM received, shutting down gracefully...');
  
  // Fermer toutes les sessions de terminal
  activeSessions.forEach((shell, id) => {
    console.log(`Closing session ${id}...`);
    try {
      shell.kill();
    } catch (e) {
      console.error(`Error closing session ${id}:`, e);
    }
  });

  server.close(() => {
    console.log('✅ Server closed');
    process.exit(0);
  });

  // Forcer la fermeture après 10 secondes
  setTimeout(() => {
    console.error('❌ Forced shutdown after timeout');
    process.exit(1);
  }, 10000);
});

/* ================= START ================= */
server.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════╗
║   🚀 Codespace Agent Running            ║
╠══════════════════════════════════════════╣
║   Port: ${PORT.toString().padEnd(31)} ║
║   Working Dir: ${WORKDIR.substring(0, 23).padEnd(23)} ║
║   Platform: ${os.platform().padEnd(28)} ║
╚══════════════════════════════════════════╝
  `);
});