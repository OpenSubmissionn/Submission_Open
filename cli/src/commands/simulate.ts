import { Command } from 'commander';
import * as fs from 'fs';
import * as path from 'path';
import ora from 'ora';
import chalk from 'chalk';
import type { CLIOptions } from '../types';

import {
  simulateTransactionInput,
  detectInputKind,
  parseLogsFromBundle,
  profileCU,
  buildCPITree,
  computeAccountDiffs,
  mergeAnalysis,
  analyzeTransaction,
  IdlCache,
  McpInsightProvider,
  renderJSON,
  type SimulationMeta,
  type SimulationInputKind,
} from '@open/services';

import { toCPITree, toParsedLogs } from '../utils/pipeline';
import { renderTerminal } from '../renderers/terminal/renderer';
import { renderCSV } from '../renderers/csv';

function nowMs(): number {
  return typeof process !== 'undefined' && process.hrtime
    ? Number(process.hrtime.bigint() / 1000000n)
    : Date.now();
}

function printSimulationBanner(meta: SimulationMeta): void {
  const status = meta.success ? chalk.green.bold('WOULD SUCCEED') : chalk.red.bold('WOULD FAIL');
  const sep = chalk.gray('─'.repeat(64));
  console.log('');
  console.log(chalk.cyan.bold('SIMULATED · NOT BROADCAST'));
  console.log(sep);
  console.log(`${chalk.dim('Verdict:       ')}${status}`);
  console.log(`${chalk.dim('Input kind:    ')}${meta.inputKind}`);
  if (meta.runnerMeta) {
    console.log(
      `${chalk.dim('Runner:        ')}${meta.runnerMeta.command} ${chalk.dim(`(${meta.runnerMeta.durationMs}ms)`)}`
    );
  }
  if (meta.errorJson) {
    console.log(`${chalk.dim('Error:         ')}${chalk.red(meta.errorJson)}`);
  }
  if (meta.returnData) {
    console.log(
      `${chalk.dim('Return data:   ')}${meta.returnData.programId} → ${meta.returnData.data}`
    );
  }
  console.log(sep);
}

function printExecWarning(input: string, kind: SimulationInputKind, inheritEnv: boolean): void {
  const sep = chalk.yellow('─'.repeat(64));
  console.log('');
  console.log(sep);
  console.log(chalk.yellow.bold('  EXECUTING USER CODE'));
  console.log(chalk.yellow(`  ${kind}: ${input}`));
  console.log(
    chalk.dim(
      inheritEnv
        ? '  env: FULL inheritance (--inherit-env) — your API keys are visible to this file'
        : '  env: secrets stripped (default) — pass --inherit-env to share them'
    )
  );
  console.log(chalk.dim('  (use --no-exec to refuse running source files)'));
  console.log(sep);
}

function printTimings(timings: { stage: string; durationMs: number }[]) {
  const pad = (s: string) => s.padEnd(22, ' ');
  for (const t of timings) {
    console.log(
      chalk.gray('  ├─'),
      chalk.cyan(pad(t.stage)),
      chalk.yellow(`${t.durationMs.toFixed(1)} ms`)
    );
  }
  const total = timings.reduce((acc, t) => acc + t.durationMs, 0);
  console.log(chalk.gray('  └─'), chalk.bold('Total'), chalk.green(`${total.toFixed(1)} ms`));
}

export const registerSimulateCommand = (program: Command) => {
  program
    .command('simulate <input>')
    .description(
      'Simulate a Solana transaction that has not been broadcast yet, and produce the same insight panel as `opendev tx`.\n\n  <input> auto-detects:\n    • base64 transaction blob\n    • .b64 / .json file containing the blob\n    • .ts / .js / .mjs / .cjs source file that prints the base64 tx on stdout\n    • .rs source file or Rust project directory (Cargo.toml) — runner cargo run --release\n\n  For confirmed on-chain transactions use `opendev tx <signature>` instead.'
    )
    .option('--network <name>', 'Solana network: mainnet or devnet (default: mainnet)', 'mainnet')
    .option('--rpc <url>', 'Custom RPC URL (e.g. http://localhost:8899 for surfpool local)')
    .option('--json', 'Output results in structured JSON format', false)
    .option('--csv', 'Output a single CSV row (with header) for BI tools', false)
    .option('--output <path>', 'Write JSON/CSV output to file instead of stdout')
    .option('--no-cache', 'Skip IDL cache and force network re-fetch')
    .option('--verbose', 'Show detailed timing for each pipeline stage')
    .option('--no-replace-blockhash', 'Do not replace recent blockhash on simulation')
    .option('--sig-verify', 'Verify signatures during simulation', false)
    .option('--no-exec', 'Refuse to execute source files (.rs/.ts/.js)')
    .option(
      '--inherit-env',
      'Pass your full environment (including API keys) to the source-file runner. ' +
        'Off by default: secret-looking vars are stripped so the executed file cannot ' +
        'read and exfiltrate your stored credentials.',
      false
    )
    .option(
      '--exec-timeout <seconds>',
      'Max seconds to wait for the source-file runner (default 90)',
      (v) => parseInt(v, 10)
    )
    .action(async (input: string, options: any) => {
      const isJson = options.json === true;
      const isCsv = options.csv === true;
      const isMachineOutput = isJson || isCsv;

      const originalLog = console.log;
      const originalError = console.error;

      if (isMachineOutput) {
        console.log = () => {};
        console.error = () => {};
      }

      const errorLog = (...args: any[]) => {
        if (!isMachineOutput) originalError(...args);
      };

      const network = (options.network ?? 'mainnet').toLowerCase();
      if (network !== 'mainnet' && network !== 'devnet') {
        errorLog(chalk.red('\nError: Invalid network.'));
        process.exitCode = 1;
        return;
      }

      let detectedKind: SimulationInputKind;
      try {
        detectedKind = detectInputKind(input);
      } catch (err: any) {
        if (isJson) {
          process.stdout.write(JSON.stringify({ error: err.message }, null, 2));
        } else if (isCsv) {
          process.stdout.write(`error,${err.message?.replace(/"/g, '""') ?? ''}\n`);
        } else {
          errorLog(chalk.red(`\nError: ${err.message}`));
        }
        process.exitCode = 1;
        console.log = originalLog;
        console.error = originalError;
        return;
      }

      const globalOpts = program.opts();
      const verbose = globalOpts.verbose === true || options.verbose === true;
      const idlCache = new IdlCache({
        noCache: options.cache === false,
        verbose: !isMachineOutput && verbose,
      });

      const allowExec = options.exec !== false;
      const isSourceKind =
        detectedKind === 'rust-source' ||
        detectedKind === 'ts-source' ||
        detectedKind === 'js-source';

      if (isSourceKind && !allowExec) {
        const msg = `--no-exec is set, but "${input}" is a source file (${detectedKind}).`;
        if (isJson) {
          process.stdout.write(JSON.stringify({ error: msg }, null, 2));
        } else if (isCsv) {
          process.stdout.write(`error,${msg.replace(/"/g, '""')}\n`);
        } else {
          errorLog(chalk.red(`\nError: ${msg}`));
        }
        process.exitCode = 1;
        console.log = originalLog;
        console.error = originalError;
        return;
      }
      if (isSourceKind && !isMachineOutput) {
        printExecWarning(input, detectedKind, options.inheritEnv === true);
      }

      const execTimeoutMs =
        typeof options.execTimeout === 'number' && !isNaN(options.execTimeout)
          ? options.execTimeout * 1000
          : undefined;

      const timings: { stage: string; durationMs: number }[] = [];
      const initialSpinnerText = isSourceKind
        ? chalk.cyan(`Running ${detectedKind} runner...`)
        : chalk.cyan('Simulating transaction...');
      const spinner = ora(initialSpinnerText);
      if (!isMachineOutput) spinner.start();

      try {
        const simStart = nowMs();
        const { bundle, meta } = await simulateTransactionInput(input, {
          network: network as 'mainnet' | 'devnet',
          rpcUrl: options.rpc,
          replaceRecentBlockhash: options.replaceBlockhash !== false,
          sigVerify: options.sigVerify === true,
          allowExec,
          inheritFullEnv: options.inheritEnv === true,
          execTimeoutMs,
          onRunnerProgress:
            !isMachineOutput && verbose
              ? (line, stream) => {
                  spinner.text =
                    stream === 'stderr'
                      ? chalk.cyan('Runner: ') + chalk.dim(line.slice(0, 80))
                      : chalk.cyan('Runner stdout: ') + chalk.dim(line.slice(0, 80));
                }
              : undefined,
        });
        timings.push({
          stage: isSourceKind ? 'run_source_and_simulate' : 'simulate_transaction',
          durationMs: nowMs() - simStart,
        });

        const anchorStart = nowMs();
        const { Connection } = await import('@solana/web3.js');
        const { AnchorProvider } = await import('@coral-xyz/anchor');
        const rpcUrl =
          options.rpc ??
          (network === 'mainnet'
            ? 'https://api.mainnet-beta.solana.com'
            : 'https://api.devnet.solana.com');
        const anchorProvider = new AnchorProvider(
          new Connection(rpcUrl, 'confirmed'),
          {
            publicKey: null,
            signTransaction: async (tx: any) => tx,
            signAllTransactions: async (txs: any) => txs,
          } as any,
          { commitment: 'confirmed' }
        );
        timings.push({ stage: 'init_anchor_provider', durationMs: nowMs() - anchorStart });

        if (!isMachineOutput) spinner.text = chalk.cyan('Parsing simulated logs and CU...');
        const parseStart = nowMs();
        const parsedLogSummary = parseLogsFromBundle(bundle.logMessages);
        const cuProfile = profileCU(bundle.logMessages);
        const cpiTrace = buildCPITree(bundle.logMessages);
        const cpiTree = toCPITree(cpiTrace);
        const accountDiffs = computeAccountDiffs(bundle);
        timings.push({ stage: 'parse_logs_and_cu', durationMs: nowMs() - parseStart });

        if (!isMachineOutput) spinner.text = chalk.cyan('Decoding instructions...');
        const decodeStart = nowMs();
        const analyzed = await mergeAnalysis(
          bundle,
          toParsedLogs(bundle.logMessages, parsedLogSummary),
          cuProfile,
          cpiTree,
          accountDiffs,
          { idlCache, anchorProvider }
        );
        timings.push({ stage: 'decode_instructions', durationMs: nowMs() - decodeStart });

        if (!isMachineOutput) spinner.text = chalk.cyan('Generating insights...');
        const insightsStart = nowMs();
        const mcpProvider = new McpInsightProvider();
        const insightsReport = await analyzeTransaction(analyzed, [mcpProvider]);
        timings.push({ stage: 'analyze_transaction', durationMs: nowMs() - insightsStart });

        if (!isMachineOutput) {
          spinner.succeed(chalk.green('Simulation analysis complete'));
        }

        if (isJson) {
          if (!analyzed._metadata) analyzed._metadata = {};
          analyzed._metadata.timings = timings;
          analyzed._metadata.simulated = true;
          analyzed._metadata.simulationMeta = {
            inputKind: meta.inputKind,
            success: meta.success,
            error: meta.errorJson,
            returnData: meta.returnData,
            accountChanges: meta.accountChanges,
          };
          const jsonOut = renderJSON(analyzed, insightsReport);
          if (options.output) {
            const outPath = path.resolve(options.output);
            fs.writeFileSync(outPath, jsonOut, 'utf-8');
            originalLog(`\nReport written to: ${outPath}`);
          } else {
            process.stdout.write(jsonOut);
          }
          if (!meta.success) process.exitCode = 1;
          return;
        }

        if (isCsv) {
          const csvOut = renderCSV(analyzed, insightsReport) + '\n';
          if (options.output) {
            const outPath = path.resolve(options.output);
            fs.writeFileSync(outPath, csvOut, 'utf-8');
            originalLog(`\nCSV written to: ${outPath}`);
          } else {
            const outPath = path.resolve(`${bundle.signature}.csv`);
            fs.writeFileSync(outPath, csvOut, 'utf-8');
            originalLog(`\nCSV written to: ${outPath}`);
          }
          if (!meta.success) process.exitCode = 1;
          return;
        }

        printSimulationBanner(meta);
        const totalMsForHeader = timings.reduce((acc, t) => acc + t.durationMs, 0);
        renderTerminal(
          analyzed,
          insightsReport,
          network as CLIOptions['network'],
          totalMsForHeader
        );

        if (verbose) {
          console.log(chalk.bold.cyan('\n[Pipeline Timings]'));
          printTimings(timings);
        }

        if (!meta.success) process.exitCode = 1;
      } catch (err: any) {
        if (isJson) {
          process.stdout.write(JSON.stringify({ error: err.message }, null, 2));
        } else if (isCsv) {
          process.stdout.write(`error,${err.message?.replace(/"/g, '""') ?? ''}\n`);
        } else {
          spinner.fail(chalk.red('Simulation failed'));
          console.error(chalk.yellow(`\nDetail: ${err.message}`));
        }
        process.exitCode = 1;
      } finally {
        console.log = originalLog;
        console.error = originalError;
      }
    });
};
