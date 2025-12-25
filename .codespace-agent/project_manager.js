const fs = require('fs').promises;
const ignore = require('ignore');
const path = require('path');
const { exec, spawn } = require('child_process');
const util = require('util');

const execPromise = util.promisify(exec);

class ProjectManager {
  constructor(basePath = '') {
    this.basePath = basePath;
    this.ignoreFilter = null;
    this.loadGitignore();
  }

  /**
   * Initialize project manager
   */
  async init() {
    try {
      await fs.mkdir(this.basePath, { recursive: true });
      return { success: true, message: 'Project manager initialized' };
    } catch (error) {
      throw new Error(`Initialization failed: ${error.message}`);
    }
  }

  /**
   * Load and parse .gitignore file
   */
  async loadGitignore() {
    try {
      const gitignorePath = path.join(this.basePath, '.gitignore');
      const gitignoreContent = await fs.readFile(gitignorePath, 'utf8');
      
      this.ignoreFilter = ignore().add(gitignoreContent);
      
      // Add hardcoded exclusions
      this.ignoreFilter.add('.devcontainer');
      this.ignoreFilter.add('.codespace-agent');
    } catch (error) {
      // If .gitignore doesn't exist, just use hardcoded exclusions
      this.ignoreFilter = ignore();
      this.ignoreFilter.add('.devcontainer');
      this.ignoreFilter.add('.codespace-agent');
    }
  }

  /**
   * Check if a path should be ignored
   */
  shouldIgnore(relativePath) {
    if (!this.ignoreFilter) {
      return false;
    }
    
    // Always exclude these directories
    const pathParts = relativePath.split(path.sep);
    if (pathParts.includes('.devcontainer') || pathParts.includes('.codespace-agent')) {
      return true;
    }
    
    return this.ignoreFilter.ignores(relativePath);
  }

  /**
   * Create a file with content
   */
  async createFile(filePath, content = '') {
    const fullPath = path.join(this.basePath, filePath);
    
    try {
      // Ensure parent directories exist
      await fs.mkdir(path.dirname(fullPath), { recursive: true });
      
      await fs.writeFile(fullPath, content, 'utf8');
      return { 
        success: true, 
        message: `File created: ${filePath}`, 
        path: fullPath 
      };
    } catch (error) {
      throw new Error(`Failed to create file: ${error.message}`);
    }
  }

  /**
   * Read file content
   */
  async readFile(filePath) {
    const fullPath = path.join(this.basePath, filePath);
    
    try {
      const content = await fs.readFile(fullPath, 'utf8');
      return { 
        success: true, 
        content, 
        path: fullPath 
      };
    } catch (error) {
      throw new Error(`Failed to read file: ${error.message}`);
    }
  }

  /**
   * Update/Edit file content
   */
  async updateFile(filePath, content) {
    const fullPath = path.join(this.basePath, filePath);
    
    try {
      await fs.writeFile(fullPath, content, 'utf8');
      return { 
        success: true, 
        message: `File updated: ${filePath}`, 
        path: fullPath 
      };
    } catch (error) {
      throw new Error(`Failed to update file: ${error.message}`);
    }
  }

  /**
   * Delete file or directory
   */
  async deletePath(targetPath) {
    const fullPath = path.join(this.basePath, targetPath);
    
    try {
      const stat = await fs.stat(fullPath);
      
      if (stat.isDirectory()) {
        await fs.rm(fullPath, { recursive: true, force: true });
        return { 
          success: true, 
          message: `Directory deleted: ${targetPath}` 
        };
      } else {
        await fs.unlink(fullPath);
        return { 
          success: true, 
          message: `File deleted: ${targetPath}` 
        };
      }
    } catch (error) {
      throw new Error(`Failed to delete path: ${error.message}`);
    }
  }

  /**
   * Rename file or directory
   */
  async renamePath(oldPath, newName) {
    const oldFullPath = path.join(this.basePath, oldPath);
    const newFullPath = path.join(this.basePath, path.dirname(oldPath), newName);
    
    try {
      await fs.rename(oldFullPath, newFullPath);
      return { 
        success: true, 
        message: `Renamed "${oldPath}" to "${newName}"`,
        oldPath: oldFullPath,
        newPath: newFullPath
      };
    } catch (error) {
      throw new Error(`Failed to rename: ${error.message}`);
    }
  }

  /**
   * List files and directories
   */
  async listDirectory(dirPath = '', recursive = false, with_content = false) {
    const fullPath = path.join(this.basePath, dirPath);
    
    try {
      const items = await fs.readdir(fullPath, { withFileTypes: true });
      
      const result = await Promise.all(
        items.map(async (item) => {
          const itemPath = path.join(dirPath, item.name);
          
          // Check if this path should be ignored
          if (this.shouldIgnore(itemPath)) {
            return null;
          }
          
          const itemData = {
            name: item.name,
            type: item.isDirectory() ? 'directory' : 'file',
            path: itemPath
          };
          
          // If recursive and it's a directory, list its contents
          if (recursive && item.isDirectory()) {
            const subResult = await this.listDirectory(itemPath, recursive, with_content);
            itemData.children = subResult.items;
          }
          
          // If with_content and it's a file, read its content
          if (with_content && item.isFile()) {
            try {
              const fileResult = await this.readFile(itemPath);
              itemData.content = fileResult.content;
            } catch (error) {
              itemData.content = null;
              itemData.contentError = error.message;
            }
          }
          
          return itemData;
        })
      );
      
      // Filter out null values (ignored items)
      const filteredResult = result.filter(item => item !== null);
      
      return { 
        success: true, 
        items: filteredResult, 
        path: fullPath 
      };
    } catch (error) {
      throw new Error(`Failed to list directory: ${error.message}`);
    }
  }
  /**
   * Run shell command with output
   */
  async runCommand(command, options = {}) {
    const defaultOptions = {
      cwd: this.basePath,
      timeout: 30000,
      ...options
    };

    try {
      const { stdout, stderr } = await execPromise(command, defaultOptions);
      
      return {
        success: true,
        command,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        exitCode: 0
      };
    } catch (error) {
      return {
        success: false,
        command,
        stdout: error.stdout?.toString().trim() || '',
        stderr: error.stderr?.toString().trim() || error.message,
        exitCode: error.code || 1
      };
    }
  }

  /**
   * Run shell command with real-time streaming output
   */
  runCommandStream(command, options = {}) {
    const defaultOptions = {
      cwd: this.basePath,
      shell: true,
      ...options
    };

    return new Promise((resolve, reject) => {
      const process = spawn(command, defaultOptions);
      let stdout = '';
      let stderr = '';

      process.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      process.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      process.on('close', (code) => {
        resolve({
          success: code === 0,
          command,
          stdout: stdout.trim(),
          stderr: stderr.trim(),
          exitCode: code
        });
      });

      process.on('error', (error) => {
        reject({
          success: false,
          command,
          error: error.message,
          exitCode: 1
        });
      });
    });
  }

  /**
   * Copy file or directory
   */
  async copyPath(sourcePath, destinationPath) {
    const sourceFullPath = path.join(this.basePath, sourcePath);
    const destinationFullPath = path.join(this.basePath, destinationPath);
    
    try {
      const stat = await fs.stat(sourceFullPath);
      
      if (stat.isDirectory()) {
        // Copy directory recursively
        await this._copyDirectory(sourceFullPath, destinationFullPath);
        return { 
          success: true, 
          message: `Directory copied: ${sourcePath} -> ${destinationPath}` 
        };
      } else {
        // Copy file
        await fs.copyFile(sourceFullPath, destinationFullPath);
        return { 
          success: true, 
          message: `File copied: ${sourcePath} -> ${destinationPath}` 
        };
      }
    } catch (error) {
      throw new Error(`Failed to copy: ${error.message}`);
    }
  }

  /**
   * Helper method to copy directory recursively
   */
  async _copyDirectory(source, destination) {
    await fs.mkdir(destination, { recursive: true });
    
    const items = await fs.readdir(source, { withFileTypes: true });
    
    for (const item of items) {
      const sourcePath = path.join(source, item.name);
      const destPath = path.join(destination, item.name);
      
      if (item.isDirectory()) {
        await this._copyDirectory(sourcePath, destPath);
      } else {
        await fs.copyFile(sourcePath, destPath);
      }
    }
  }

  /**
   * Get file/directory stats
   */
  async getStats(targetPath) {
    const fullPath = path.join(this.basePath, targetPath);
    
    try {
      const stat = await fs.stat(fullPath);
      
      return {
        success: true,
        exists: true,
        isFile: stat.isFile(),
        isDirectory: stat.isDirectory(),
        size: stat.size,
        created: stat.birthtime,
        modified: stat.mtime,
        path: fullPath
      };
    } catch (error) {
      if (error.code === 'ENOENT') {
        return {
          success: true,
          exists: false,
          path: fullPath
        };
      }
      throw new Error(`Failed to get stats: ${error.message}`);
    }
  }
}

module.exports = ProjectManager;
