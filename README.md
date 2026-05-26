<div align="center">
  <img src="web/open-wordmark.svg" alt="OPEN" width="220" />
  <h3>Chrome DevTools for Solana.</h3>
  <p>Turn any transaction signature into a fully decoded execution profile — compute units, CPI call tree, account diffs, and AI-augmented insights.</p>

  <a href="https://opendev-kappa.vercel.app/">Web</a> &nbsp;·&nbsp;
  <a href="https://open-dbe26606.mintlify.app">Docs</a> &nbsp;·&nbsp;
  <a href="https://x.com/OpenDevT">X</a>
</div>

---

**One signature in. A complete picture out.** Replay any confirmed transaction, inspect every instruction, profile compute units across the CPI tree, diff account state, and surface optimization wins — rule-based by default, AI-augmented when you bring a key.

| Use case | What it does |
|---|---|
| **Debug failures** | Replay a confirmed transaction and see exactly which CPI failed and why. |
| **Profile compute** | Per-instruction CU breakdown so you know which step is burning your budget. |
| **Pre-flight** | Simulate unsigned transactions from a base64 blob, `.ts`, `.rs`, or `.b64` file. |
| **Batch audit** | Run a list of signatures and export CSV/JSON for further analysis. |
| **Catch anomalies** | Spam, MEV-like patterns, and nondeterministic failures flagged automatically. |
| **AI insights** | Plain-English optimization suggestions on top of deterministic rules. |

## How it works

Same engine on web and CLI.

| Step | What happens |
|---|---|
| **01 Fetch** | Pull the confirmed transaction and account states from any Solana RPC. |
| **02 Decode** | Anchor IDLs and native decoders resolve every instruction to typed arguments. |
| **03 Profile** | Compute units, CPI tree, log slices, and account diffs assembled per instruction. |
| **04 Insight** | Rule-based checks run locally; if a key is configured, an LLM adds suggestions. |

Works on mainnet and devnet · Plug your own RPC · `--json` and `--csv` ready for pipelines

## Try it

Paste a signature into the [web app](https://opendev-tx-solana.vercel.app) — no install required.

Or use the CLI:

```sh
npm install -g opendevtool
opendev tx <SIGNATURE> --network mainnet
```

→ [Quickstart](https://open-dbe26606.mintlify.app) &nbsp; 


## Contributors

[![Contributors](https://contrib.rocks/image?repo=OpenSubmissionn/Open_DevTool)](https://github.com/OpenSubmissionn/Open_DevTool/graphs/contributors)

## License

[MIT](LICENSE)
