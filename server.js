import express from 'express';
import dotenv from 'dotenv';
dotenv.config();

import cors from 'cors';
import multer from 'multer';
import fs from 'fs-extra';
import path from 'path';
import JSZip from 'jszip';
import { glob } from 'glob';
import { v4 as uuidv4 } from 'uuid';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { WebSocketServer } from 'ws';

// ---------------- WebSocket setup ----------------

const wss = new WebSocketServer({ port: 8082, path: '/ws/' });
const wsClients = new Map();

wss.on('connection', (ws) => {
  ws.on('message', (msg) => {
    try {
      const { requestId } = JSON.parse(msg);
      if (requestId) {
        wsClients.set(requestId, ws);
        ws.send(JSON.stringify({ logMsg: `[WS] Bound to requestId: ${requestId}` }));
      }
    } catch (e) {
      console.error('[WS] Invalid message from client:', msg);
    }
  });

  ws.on('close', () => {
    for (const [key, client] of wsClients.entries()) {
      if (client === ws) wsClients.delete(key);
    }
  });
});

function sendLog(requestId, msg) {
  const ws = wsClients.get(requestId);
  if (ws && ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify({ logMsg: msg }));
  }
}

// ---------------- Env & Upload ----------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
});

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type'],
}));
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ success: false, error: 'Uploaded file is too large (max 5MB).' });
  }
  next(err);
});

// ---------------- Run command ----------------

const run = (cmd, args, cwd, requestId) => new Promise((resolve, reject) => {
  const isMac = process.platform === 'darwin';
  const proc = spawn(cmd, args, {
    cwd,
    shell: true,
    env: {
      ...process.env,
      PATH: [
        process.env.PATH,
        isMac
          ? `${process.env.HOME}/.nargo/bin:${process.env.HOME}/.bb`
          : '/home/ubuntu/.nargo/bin:/home/ubuntu/.bb'
      ].join(':')
    }
  });

  let stderrLog = '';

  proc.stdout.on('data', (data) => {
    const log = data.toString().trim();
    console.log(`[${cmd}] stdout:`, log);
    if (requestId) sendLog(requestId, `[stdout] ${log}`);
  });

  proc.stderr.on('data', (data) => {
    const log = data.toString().trim();
    console.error(`[${cmd}] stderr:`, log);
    if (requestId) sendLog(requestId, `[stderr] ${log}`);
    stderrLog += log + '\n';
  });

  proc.on('close', (code) => {
    if (code === 0) {
      const successMsg = `[${cmd}] Completed successfully`;
      console.log(successMsg);
      if (requestId) sendLog(requestId, successMsg);
      resolve();
    } else {
      const errMsg = `[${cmd}] Failed with code ${code}`;
      if (requestId) sendLog(requestId, errMsg);
      reject(new Error(errMsg + '\n' + stderrLog));
    }
  });

  proc.on('error', (error) => {
    if (requestId) sendLog(requestId, `[${cmd}] error: ${error.message}`);
    reject(error);
  });
});

// ---------------- Extract zip ----------------

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

// ---------------- Health check ----------------

app.get('/', (req, res) => {
  res.send('Noir backend is running');
});

// ---------------- /compile ----------------

app.post('/compile', upload.single('file'), async (req, res) => {
  const requestId = req.query.requestId || uuidv4();
  console.log(requestId)
  const zipBuffer = req.file?.buffer;
  const projectPath = path.join(__dirname, 'uploads', requestId);

  if (!zipBuffer) return res.status(400).json({ success: false, error: 'No file provided' });

  try {
    await fs.mkdirp(projectPath);
    await extractZipStripRoot(zipBuffer, projectPath);
    await run('nargo', ['compile'], projectPath, requestId);
    await run('nargo', ['check'], projectPath, requestId);

    const targetDir = path.join(projectPath, 'target');
    const files = await fs.readdir(targetDir);
    const jsonFile = files.find(f => f.endsWith('.json'));
    if (!jsonFile) throw new Error('Compiled JSON file not found');

    const json = await fs.readFile(path.join(targetDir, jsonFile), 'utf8');
    const prover = await fs.readFile(path.join(projectPath, 'Prover.toml'), 'utf8');

    sendLog(requestId, 'Compilation succeeded!');
    res.json({ success: true, requestId, compiledJson: json, proverToml: prover });
  } catch (e) {
    console.error('[compile] Error:', e);
    sendLog(requestId, `Compilation failed: ${e.message}`);
    res.status(500).json({ success: false, error: e.message });
  } finally {
    await fs.remove(projectPath).catch(err => console.error('cleanup error:', err));
  }
});

// ---------------- /generate-proof-with-solidity-verifier ----------------

app.post('/generate-proof', upload.single('file'), async (req, res) => {
  const requestId = req.query.requestId || uuidv4();
  const zipBuffer = req.file?.buffer;
  const projectPath = path.join(__dirname, 'uploads', requestId);

  if (!zipBuffer) return res.status(400).json({ success: false, error: 'No file provided' });

  try {
    await fs.mkdirp(projectPath);
    await extractZipStripRoot(zipBuffer, projectPath);

    const proverPaths = await glob(path.join(projectPath, '**/Prover.toml'));
    if (proverPaths.length === 0) throw new Error('Prover.toml not found in uploaded zip');
    const proverPath = proverPaths[0];
    sendLog(requestId, `[debug] Found Prover.toml at: ${proverPath}`);

    await run('nargo', ['execute'], projectPath, requestId);

    const targetDir = path.join(projectPath, 'target');
    const files = await fs.readdir(targetDir);
    const jsonFile = files.find(f => f.endsWith('.json'));
    if (!jsonFile) throw new Error('Compiled circuit JSON not found in target/');

    const gzFile = files.find(f => f.endsWith('.gz'));
    if (!gzFile) throw new Error('Witness file (.gz) not found in target/');
    const witnessFile = `target/${gzFile}`;
    sendLog(requestId, `[generate-proof] Using witness file: ${witnessFile}`);

    await run('bb', ['prove', '-b', `target/${jsonFile}`, '-w', witnessFile, '-o', 'target'], projectPath, requestId);
    await run('bb', ['write_vk', '-b', `target/${jsonFile}`, '-o', 'target', '--oracle_hash', 'keccak'], projectPath, requestId);
    await run('bb', ['write_solidity_verifier', '-k', 'target/vk', '-o', 'target/Verifier.sol'], projectPath, requestId);

    const proof = await fs.readFile(path.join(targetDir, 'proof'), 'utf8');
    const vk = await fs.readFile(path.join(targetDir, 'vk'), 'utf8');
    const verifier = await fs.readFile(path.join(targetDir, 'Verifier.sol'), 'utf8');

    sendLog(requestId, 'Proof + Verifier generated successfully.');
    res.json({ success: true, requestId, proof, vk, verifier });
  } catch (e) {
    console.error('[generate-proof] Error:', e);
    sendLog(requestId, `generate-proof failed: ${e.message}`);
    res.status(500).json({ success: false, error: e.message });
  } finally {
    await fs.remove(projectPath).catch(err => console.error('cleanup error:', err));
  }
});

// ---------------- /generate-proof-with-solidity-and-cairo-verifier ----------------

app.post('/generate-proof-with-verifier', upload.single('file'), async (req, res) => {
  const requestId = req.query.requestId || uuidv4();
  const includeStarknetVerifier = req.query.includeStarknetVerifier === 'true';
  const zipBuffer = req.file?.buffer;
  const projectPath = path.join(__dirname, 'uploads', requestId);

  if (!zipBuffer) return res.status(400).json({ success: false, error: 'No file provided' });

  try {
    await fs.mkdirp(projectPath);
    await extractZipStripRoot(zipBuffer, projectPath);

    const proverPaths = await glob(path.join(projectPath, '**/Prover.toml'));
    if (proverPaths.length === 0) throw new Error('Prover.toml not found in uploaded zip');
    const rootDir = path.dirname(proverPaths[0]);

    sendLog(requestId, `[debug] Found Prover.toml at: ${proverPaths[0]}`);

    await run('nargo', ['execute'], rootDir, requestId);

    const targetDir = path.join(rootDir, 'target');
    const files = await fs.readdir(targetDir);
    const jsonFile = files.find(f => f.endsWith('.json'));
    if (!jsonFile) throw new Error('Compiled circuit JSON not found in target/');

    const gzFile = files.find(f => f.endsWith('.gz'));
    if (!gzFile) throw new Error('Witness file (.gz) not found in target/');
    const witnessFile = `target/${gzFile}`;
    sendLog(requestId, `[generate-proof] Using witness file: ${witnessFile}`);

    await run('bb', ['prove', '-b', `target/${jsonFile}`, '-w', witnessFile, '-o', 'target'], rootDir, requestId);
    await run('bb', ['write_vk', '-b', `target/${jsonFile}`, '-o', 'target', '--oracle_hash', 'keccak'], rootDir, requestId);
    await run('bb', ['write_solidity_verifier', '-k', 'target/vk', '-o', 'target/Verifier.sol'], rootDir, requestId);

    const proof = await fs.readFile(path.join(targetDir, 'proof'));
    const vk = await fs.readFile(path.join(targetDir, 'vk'));
    const verifier = await fs.readFile(path.join(targetDir, 'Verifier.sol'));

    const zip = new JSZip();
    zip.file('proof', proof);
    zip.file('vk', vk);
    zip.file('verifier/solidity/Verifier.sol', verifier);

    if (includeStarknetVerifier) {
      sendLog(requestId, 'Generating Starknet Cairo verifier...');
      try {
        // const garagaPath = '/Users/sooyounghyun/Desktop/dev/garaga/venv/bin/garaga';
        const garagaPath = '/home/ubuntu/garaga-venv/bin/garaga';

        await run(garagaPath, [
          'gen',
          '--system',
          'ultra_keccak_honk',
          '--vk',
          'target/vk',
          '--project-name',
          'verifier'
        ], rootDir, requestId);  
      } catch (error) {
        console.warn(`Warning: Garaga formatting failed, continuing...`);
      }
      console.log({rootDir})
      
      const verifierDir = path.join(rootDir, 'verifier', 'src');
      console.log({verifierDir})

      const cairoFiles = await glob(path.join(verifierDir, '*.cairo'));
      console.log({cairoFiles})

      if (cairoFiles.length === 0) throw new Error('No Cairo verifier files found');

      for (const filePath of cairoFiles) {
        zip.file(`verifier/cairo/${path.basename(filePath)}`, await fs.readFile(filePath));
      }

      sendLog(requestId, 'Starknet verifier added to ZIP.');
    }

    const zipBufferOut = await zip.generateAsync({ type: 'nodebuffer' });

    res.set('Content-Type', 'application/zip');
    res.set('Content-Disposition', `attachment; filename=verifier_${requestId}.zip`);
    res.send(zipBufferOut);
  } catch (e) {
    console.error('[generate-proof] Error:', e);
    sendLog(requestId, `generate-proof failed: ${e.message}`);
    res.status(500).json({ success: false, error: e.message });
  } finally {
    // await fs.remove(projectPath).catch(err => console.error('cleanup error:', err));
  }
});

// ---------------- Start ----------------

app.listen(3000, () => {
  console.log('Noir backend running on port 3000');
});
