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

const garagaPath = '/home/ubuntu/garaga-venv/bin/garaga';
// const garagaPath = '/Users/sooyounghyun/Desktop/dev/garaga/venv/bin/garaga';

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
  try {
    const ws = wsClients.get(requestId);
    if (ws && ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ logMsg: msg }));
    } else {
      console.warn(`[sendLog] No active WebSocket for requestId=${requestId}`);
    }
  } catch (e) {
    console.error(`[sendLog] Failed to send log for requestId=${requestId}:`, e.message);
  }
}

// ---------------- Env & Upload ----------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
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
    return res.status(413).json({ success: false, error: 'Uploaded file is too large (max 20MB).' });
  }
  next(err);
});

// ---------------- Run command ----------------
const run = (cmd, args, cwd, requestId) => new Promise((resolve, reject) => {
  const proc = spawn(cmd, args, {
    cwd,
    shell: true,
    env: {
      ...process.env,
      PATH: [
        process.env.PATH,
        process.platform === 'darwin'
          ? `${process.env.HOME}/.nargo/bin:${process.env.HOME}/.bb`
          : '/home/ubuntu/.nargo/bin:/home/ubuntu/.bb'
      ].join(':')
    }
  });

  let stderrLog = '';
  let stdoutLog = '';

  proc.stdout.on('data', (data) => {
    const log = data.toString().trim();
    stdoutLog += log + '\n';
    console.log(`[${cmd}] stdout:`, log);
    if (requestId) sendLog(requestId, `[${cmd}] stdout: ${log}`);
  });

  proc.stderr.on('data', (data) => {
    const log = data.toString().trim();
    stderrLog += log + '\n';
    console.error(`[${cmd}] stderr:`, log);
    if (requestId) sendLog(requestId, `[${cmd}] stderr: ${log}`);
  });

  proc.on('close', (code) => {
    const msg = `[${cmd}] Completed with exit code ${code}`;
    if (requestId) sendLog(requestId, msg);
    code === 0 ? resolve() : reject(new Error(`${msg}\n${stderrLog}`));
  });

  proc.on('error', (error) => {
    const msg = `[${cmd}] Error: ${error.message}`;
    if (requestId) sendLog(requestId, msg);
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
// ⚠️ [DEPRECATED] This endpoint is still used in production but is scheduled for removal.
// Use `/compile-with-profiler` instead for future-proof and profiler-capable compilation.
app.post('/compile', upload.single('file'), async (req, res) => {
  const requestId = req.query.requestId || uuidv4();
  console.log(requestId)
  console.log('Uploaded file size:', req.file?.size, 'bytes');
  const zipBuffer = req.file?.buffer;
  const projectPath = path.join(__dirname, 'uploads', requestId);

  if (!zipBuffer) return res.status(400).json({ success: false, error: 'No file provided' });

  try {
    await fs.mkdirp(projectPath);
    await extractZipStripRoot(zipBuffer, projectPath);

    const nargoTomlPaths = await glob(path.join(projectPath, '**/Nargo.toml'));
    if (nargoTomlPaths.length === 0) {
      throw new Error('Cannot find Nargo.toml');
    }
    const rootDir = path.dirname(nargoTomlPaths[0]);
    sendLog(requestId, `[debug] root: ${rootDir}`);

    await run('nargo', ['compile'], rootDir, requestId);
    await run('nargo', ['check'], rootDir, requestId);

    const targetDir = path.join(rootDir, 'target');
    const files = await fs.readdir(targetDir);
    const jsonFile = files.find(f => f.endsWith('.json'));
    if (!jsonFile) throw new Error('Compiled JSON file not found');

    const json = await fs.readFile(path.join(targetDir, jsonFile), 'utf8');
    const prover = await fs.readFile(path.join(rootDir, 'Prover.toml'), 'utf8');

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

// -------------------- /compile-with-profiler --------------------
app.post('/compile-with-profiler', upload.single('file'), async (req, res) => {
  const requestId = req.query.requestId || uuidv4();
  const profilers = (req.query.profiler || '').split(',').filter(Boolean);
  const zip = new JSZip();
  const projectPath = path.join(__dirname, 'uploads', requestId);
  console.log('Uploaded file size:', req.file?.size, 'bytes');
  try {
    await fs.mkdirp(projectPath);

    const zipBuffer = req.file?.buffer;
    if (!zipBuffer) throw new Error('No file uploaded');

    await extractZipStripRoot(zipBuffer, projectPath);

    await run('nargo', ['compile'], projectPath, requestId);
    await run('nargo', ['check'], projectPath, requestId);

    const targetDir = path.join(projectPath, 'target');
    const jsonFile = (await fs.readdir(targetDir)).find(f => f.endsWith('.json'));
    if (!jsonFile) throw new Error('Compiled JSON not found');

    zip.file(`compiled/${jsonFile}`, await fs.readFile(path.join(targetDir, jsonFile)));

    // ACIR opcode profiling only
    if (profilers.includes('acir')) {
      sendLog(requestId, '[profiler] Running ACIR opcode profiler...');
      await run('noir-profiler', [
        'opcodes',
        '--artifact-path', `./target/${jsonFile}`,
        '--output', './target'
      ], projectPath, requestId);
    }

    // Collect .svg profiler output
    const svgFiles = await glob(path.join(targetDir, '*_opcodes.svg'));
    for (const filePath of svgFiles) {
      const name = path.basename(filePath);
      zip.file(`profiler/${name}`, await fs.readFile(filePath));
    }

    const zipBufferOut = await zip.generateAsync({ type: 'nodebuffer' });
    res.set('Content-Type', 'application/zip');
    res.set('Content-Disposition', `attachment; filename=compile_profiler_${requestId}.zip`);
    res.send(zipBufferOut);
  } catch (e) {
    console.error('[compile-with-profiler] Error:', e);
    sendLog(requestId, `compile-with-profiler failed: ${e.message}`);
    res.status(500).json({ success: false, error: e.message });
  } finally {
    await fs.remove(projectPath).catch(err => console.error('cleanup error:', err));
  }
});

// ---------------- /generate-proof ----------------
// ⚠️ [DEPRECATED] This endpoint is still used in production but is scheduled for removal.
// Use `/generate-proof-with-verifier` instead for support with optional Starknet & profiling features.
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

// -------------------- /generate-proof-with-verifier --------------------
app.post('/generate-proof-with-verifier', upload.single('file'), async (req, res) => {
  const requestId = req.query.requestId || uuidv4();
  const includeStarknetVerifier = req.query.includeStarknetVerifier === 'true';
  const profilers = (req.query.profiler || '').split(',').filter(Boolean);
  const zip = new JSZip();

  const zipBuffer = req.file?.buffer;
  const projectPath = path.join(__dirname, 'uploads', requestId);

  if (!zipBuffer) return res.status(400).json({ success: false, error: 'No file provided' });

  try {
    await fs.mkdirp(projectPath);
    await extractZipStripRoot(zipBuffer, projectPath);

    const proverPaths = await glob(path.join(projectPath, '**/Prover.toml'));
    if (proverPaths.length === 0) throw new Error('Prover.toml not found in uploaded zip');
    const rootDir = path.dirname(proverPaths[0]);

    await run('nargo', ['execute'], rootDir, requestId);

    const targetDir = path.join(rootDir, 'target');
    const files = await fs.readdir(targetDir);
    const jsonFile = files.find(f => f.endsWith('.json'));
    if (!jsonFile) throw new Error('Compiled circuit JSON not found');

    const gzFile = files.find(f => f.endsWith('.gz'));
    if (!gzFile) throw new Error('Witness file (.gz) not found');
    const witnessFile = `target/${gzFile}`;

    await run('bb', ['prove', '-b', `target/${jsonFile}`, '-w', witnessFile, '-o', 'target'], rootDir, requestId);
    await run('bb', ['write_vk', '-b', `target/${jsonFile}`, '-o', 'target', '--oracle_hash', 'keccak'], rootDir, requestId);
    await run('bb', ['write_solidity_verifier', '-k', 'target/vk', '-o', 'target/Verifier.sol'], rootDir, requestId);

    // Gate-level profiling (requires bb prove already done)
    // if (profilers.includes('gates')) {
    //   sendLog(requestId, '[profiler] Running gate-level profiler...');
    //   try {
    //     await run('noir-profiler', [
    //       'gates',
    //       '--artifact-path', `./target/${jsonFile}`,
    //       '--backend-path', 'bb',
    //       '--output', './target',
    //       '--', '--include_gates_per_opcode'
    //     ], rootDir, requestId);
    //   } catch (e) {
    //     sendLog(requestId, '[warn] Gate-level profiling failed: ' + e.message);
    //   }
    // }

    // Execution trace profiling (requires Prover.toml)
    if (profilers.includes('exec')) {
      sendLog(requestId, '[profiler] Running execution trace profiler...');
      try {
        await run('noir-profiler', [
          'execution-opcodes',
          '--artifact-path', `./target/${jsonFile}`,
          '--prover-toml-path', 'Prover.toml',
          '--output', './target'
        ], rootDir, requestId);
      } catch (e) {
        sendLog(requestId, '[warn] Execution trace profiling failed: ' + e.message);
      }
    }

    // (Optional) Starknet Cairo verifier
    if (includeStarknetVerifier) {
      sendLog(requestId, '[garaga] Generating Starknet verifier...');
      try {
        await run(garagaPath, [
          'gen',
          '--system', 'ultra_keccak_honk',
          '--vk', 'target/vk',
          '--project-name', 'verifier'
        ], rootDir, requestId);
        sendLog(requestId, '[garaga] Garaga executed successfully');
      } catch (e) {
        sendLog(requestId, '[garaga] Garaga execution returned error (likely from scarb fmt), continuing...');
      }
      
      // regardless of error, attempt to collect .cairo files
      try {
        const verifierDir = path.join(rootDir, 'verifier');
        
        const cairoFiles = await glob(path.join(verifierDir, 'src', '**/*.cairo'));
        for (const filePath of cairoFiles) {
          const relative = path.relative(path.join(verifierDir, 'src'), filePath);
          const zipPath = `verifier/cairo/src/${relative}`;
          zip.file(zipPath, await fs.readFile(filePath));
          sendLog(requestId, `[zip] Added Cairo source: ${zipPath}`);
        }
        for (const metaFile of ['Scarb.toml', '.tool-versions']) {
          const fullPath = path.join(verifierDir, metaFile);
          if (await fs.pathExists(fullPath)) {
            const zipPath = `verifier/cairo/${metaFile}`;
            zip.file(zipPath, await fs.readFile(fullPath));
            sendLog(requestId, `[zip] Added metadata: ${zipPath}`);
          }
        }
      } catch (err) {
        sendLog(requestId, '[garaga] Failed to include Cairo verifier files: ' + err.message);
      }
    }

    // Core output files
    const proof = await fs.readFile(path.join(targetDir, 'proof'));
    const vk = await fs.readFile(path.join(targetDir, 'vk'));
    const verifier = await fs.readFile(path.join(targetDir, 'Verifier.sol'));

    zip.file('proof', proof);
    zip.file('vk', vk);
    zip.file('verifier/solidity/Verifier.sol', verifier);

    // Collect .svg profiler output
    const svgFiles = await glob(path.join(targetDir, '*.svg'));
    for (const filePath of svgFiles) {
      const name = path.basename(filePath);
      zip.file(`profiler/${name}`, await fs.readFile(filePath));
    }

    const zipBufferOut = await zip.generateAsync({ type: 'nodebuffer' });
    res.set('Content-Type', 'application/zip');
    res.set('Content-Disposition', `attachment; filename=verifier_${requestId}.zip`);
    res.send(zipBufferOut);
  } catch (e) {
    console.error('[generate-proof-with-verifier] Error:', e);
    sendLog(requestId, `generate-proof-with-verifier failed: ${e.message}`);
    res.status(500).json({ success: false, error: e.message });
  } finally {
    await fs.remove(projectPath).catch(err => console.error('cleanup error:', err));
  }
});

// ---------------- Start ----------------
app.listen(3000, () => {
  console.log('Noir backend running on port 3000');
});
