const express = require('express')
const cors = require('cors')
const app = express()
const port = 3001
const ProjectManager = require('./project_manager');

const projectManager = new ProjectManager('../');

app.use(cors({
    origin: (origin, cb) => {
      console.log(origin)
      if (
        !origin ||
        origin.includes(".app.github.dev") ||
        origin.includes("localhost") ||
        origin.includes(".scf.usercontent.goog")
      ) {
        cb(null, origin);
      } else {
        cb(new Error("CORS blocked"));
      }
    },
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    credentials: false,
  }))

// Add body parser middleware
app.use(express.json())
app.use(express.urlencoded({ extended: true }))

app.get('/health', (req, res) => {
  res.sendStatus(200)
})

// Create files (accepts array of {path, content})
app.post('/api/files/create', async (req, res) => {
  try {
    const { files } = req.body;
    
    if (!Array.isArray(files)) {
      return res.status(400).json({ 
        success: false, 
        error: 'files must be an array of {path, content} objects' 
      });
    }

    const results = await Promise.all(
      files.map(async (file) => {
        try {
          const { path, content } = file;
          if (!path) {
            return { path, success: false, error: 'path is required' };
          }
          const result = await projectManager.createFile(path, content || '');
          return { path, ...result };
        } catch (error) {
          return { path: file.path, success: false, error: error.message };
        }
      })
    );

    res.json({ success: true, files: results });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Read files (accepts list of filepaths)
app.post('/api/files', async (req, res) => {
  try {
    const { files } = req.body; // Array of file paths
    console.log(req.body)
    if (!Array.isArray(files)) {
      return res.status(400).json({ 
        success: false, 
        error: 'files must be an array of file paths' 
      });
    }

    const results = await Promise.all(
      files.map(async (filePath) => {
        try {
          const result = await projectManager.readFile(filePath);
          return { path: filePath, ...result };
        } catch (error) {
          return { path: filePath, success: false, error: error.message };
        }
      })
    );

    res.json({ success: true, files: results });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Update a file
app.post('/api/files/update', async (req, res) => {
  try {
    const { path, content } = req.body;
    const result = await projectManager.updateFile(path, content);
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Move/rename file or directory
app.post('/api/files/move', async (req, res) => {
  try {
    const { source, destination } = req.body;
    const result = await projectManager.renamePath(source, destination);
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Copy file or directory
app.post('/api/files/copy', async (req, res) => {
  try {
    const { source, destination } = req.body;
    const result = await projectManager.copyPath(source, destination);
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Delete file or directory
app.post('/api/files/delete', async (req, res) => {
  try {
    const { path } = req.body;
    const result = await projectManager.deletePath(path);
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// List directory contents
app.post('/api/ls', async (req, res) => {
  try {
    const { path, recursive = false, with_content = false } = req.body;
    const dirPath = path || '';
    const result = await projectManager.listDirectory(dirPath, recursive, with_content);
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get file/directory stats
app.post('/api/files/stats', async (req, res) => {
  try {
    const { path } = req.body;
    const result = await projectManager.getStats(path);
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Run shell command
app.post('/api/shell', async (req, res) => {
  try {
    const { command, cwd, stream } = req.body;
    
    if (!command) {
      return res.status(400).json({ 
        success: false, 
        error: 'command is required' 
      });
    }
    
    if (stream) {
      const result = await projectManager.runCommandStream(command, { cwd });
      res.json(result);
    } else {
      const result = await projectManager.runCommand(command, { cwd });
      res.json(result);
    }
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.listen(port, () => {
  console.log(`Example app listening on port ${port}`)
})
