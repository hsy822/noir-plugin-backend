# Noir Plugin Backend

API server for compiling and proving Noir circuits with real-time log streaming and optional profiling/verifier generation.

## Features

- Compile Noir projects and generate `Prover.toml`
- Generate ZK proofs with `bb` and `nargo`
- Generate Solidity and Cairo verifiers
- Profile circuits with ACIR and execution trace (Brillig)
- Real-time log streaming over WebSocket
- Unified ZIP output for frontend integration

## Endpoints

### `/compile-with-profiler`
- Compile Noir project with optional ACIR opcode profiling
- Returns ZIP with compiled circuit and flamegraph (if enabled)

### `/generate-proof-with-verifier`
- Runs full proof pipeline and outputs:
  - `proof`, `vk`
  - Solidity verifier
  - Cairo verifier (optional)
  - Execution trace flamegraph (optional)

## 🔁 WebSocket Logs

- Connect to `/ws/` and send `{ "requestId": "<uuid>" }`
- Receive logs in real-time as JSON `{ logMsg: "..." }`

## 🧪 Try It

- [Test UI](https://github.com/hsy822/noir-plugin-backend/blob/main/noir-tester.html)
- Upload your zipped Noir project and monitor logs live

## Notes

- `profiler=gates` is currently **disabled** due to circuit size issues  
  → This will be re-enabled after investigation with the Noir team

## Full Docs

👉 [Notion API Specification](https://www.notion.so/hyunsooyoung/noir-plugin-backend-1de572c501788061b012f746415909a9)

---

MIT License
