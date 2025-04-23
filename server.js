import express from 'express';
import dotenv from 'dotenv';
dotenv.config();

import multer from 'multer';
import fs from 'fs-extra';
import path from 'path';
import JSZip from 'jszip';
import { glob } from 'glob';
import { v4 as uuidv4 } from 'uuid';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

// Environment setup
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Setup for in-memory file upload
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
});

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ success: false, error: 'Uploaded file is too large (max 5MB).' });
  }
  next(err);
});

// Execute a shell command in a child process
const run = (cmd, args, cwd) => new Promise((resolve, reject) => {
  const proc = spawn(cmd, args, { cwd, shell: true });
  let stderrLog = '';

  proc.stdout.on('data', (data) => console.log(`[${cmd}] stdout:`, data.toString().trim()));
  proc.stderr.on('data', (data) => {
    const log = data.toString().trim();
    stderrLog += log + '\n';
    if (log.toLowerCase().includes('error')) {
      console.error(`[${cmd}] error:`, log);
    } else {
      console.warn(`[${cmd}] warn:`, log);
    }
  });

  proc.on('close', (code) => {
    if (code === 0) {
      console.log(`[${cmd}] completed successfully`);
      resolve();
    } else {
      reject(new Error(`[${cmd}] failed with code ${code}\n${stderrLog}`));
    }
  });

  proc.on('error', (error) => reject(error));
});

// Extract zip archive and remove common root folder
const extractZipStripRoot = async (zipBuffer, targetPath) => {
  const zip = await JSZip.loadAsync(zipBuffer);
  const entries = Object.keys(zip.files);
  const entryPaths = entries.filter(e => !e.endsWith('/'));

  let rootPrefix = '';
  if (entryPaths.length > 0) {
    const firstPathParts = entryPaths[0].split('/');
    if (firstPathParts.length > 1) {
      const candidatePrefix = firstPathParts[0] + '/';
      const allHavePrefix = entryPaths.every(p => p.startsWith(candidatePrefix));
      if (allHavePrefix) {
        rootPrefix = candidatePrefix;
        console.log(`[extractZip] Removing common root prefix: "${rootPrefix}"`);
      }
    }
  }

  for (const filename of entries) {
    try {
      const file = zip.files[filename];
      const strippedPath = rootPrefix ? filename.replace(rootPrefix, '') : filename;
      if (!strippedPath) continue;

      const fullPath = path.join(targetPath, strippedPath);
      const normalizedPath = path.normalize(fullPath);
      if (!normalizedPath.startsWith(targetPath)) {
        throw new Error(`Unsafe file path detected: ${filename}`);
      }

      if (file.dir) {
        await fs.mkdirp(normalizedPath);
      } else {
        await fs.mkdirp(path.dirname(normalizedPath));
        const content = await file.async('nodebuffer');
        await fs.writeFile(normalizedPath, content);
      }
    } catch (err) {
      console.warn(`[extractZip] Failed to extract "${filename}":`, err.message);
    }
  }
};

// Health check route
app.get('/', (req, res) => {
  res.send('Noir backend is running');
});

// Main API to compile, prove, and generate Solidity verifier
app.post('/generate-proof', upload.single('file'), async (req, res) => {
  const requestId = uuidv4();
  const zipBuffer = req.file?.buffer;
  const projectPath = path.join(__dirname, 'uploads', requestId);

  if (!zipBuffer) return res.status(400).json({ success: false, error: 'No file provided' });

  try {
    await fs.mkdirp(projectPath);
    await extractZipStripRoot(zipBuffer, projectPath);

    const proverPaths = await glob(path.join(projectPath, '**/Prover.toml'));
    if (proverPaths.length === 0) throw new Error('Prover.toml not found in uploaded zip');
    const proverPath = proverPaths[0];
    console.log('[debug] Found Prover.toml at:', proverPath);

    await run('nargo', ['execute'], projectPath);

    const targetDir = path.join(projectPath, 'target');
    const files = await fs.readdir(targetDir);
    const jsonFile = files.find(f => f.endsWith('.json'));
    if (!jsonFile) throw new Error('Compiled circuit JSON not found in target/');

    const gzFile = files.find(f => f.endsWith('.gz'));
    if (!gzFile) throw new Error('Witness file (.gz) not found in target/');
    const witnessFile = `target/${gzFile}`;
    console.log(`[generate-proof] Using witness file: ${witnessFile}`);

    await run('bb', ['prove', '-b', `target/${jsonFile}`, '-w', witnessFile, '-o', 'target'], projectPath);
    await run('bb', ['write_vk', '-b', `target/${jsonFile}`, '-o', 'target', '--oracle_hash', 'keccak'], projectPath);
    await run('bb', ['write_solidity_verifier', '-k', 'target/vk', '-o', 'target/Verifier.sol'], projectPath);

    const proof = await fs.readFile(path.join(targetDir, 'proof'), 'utf8');
    const vk = await fs.readFile(path.join(targetDir, 'vk'), 'utf8');
    const verifier = await fs.readFile(path.join(targetDir, 'Verifier.sol'), 'utf8');

    res.json({ success: true, requestId, proof, vk, verifier });
  } catch (e) {
    console.error('[generate-proof] Error:', e);
    res.status(500).json({ success: false, error: e.message });
  } finally {
    await fs.remove(projectPath).catch(err => console.error('cleanup error:', err));
  }
});

app.listen(3000, () => {
  console.log('Noir backend running on port 3000');
});
