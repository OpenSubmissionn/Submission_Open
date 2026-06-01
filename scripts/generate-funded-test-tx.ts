import {
  Connection,
  Keypair,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
  LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import * as fs from 'fs';
import * as path from 'path';

const RPC =
  process.env.HELIUS_DEVNET_RPC || process.env.HELIUS_RPC_URL || 'https://api.devnet.solana.com';
const NETWORK_LABEL = RPC.includes('devnet') ? 'devnet' : RPC;

const KEYPAIR_PATH = path.resolve(process.cwd(), 'test-keypair.json');
const TX_OUT_PATH = path.resolve(process.cwd(), 'test-tx.b64');

const AIRDROP_LAMPORTS = LAMPORTS_PER_SOL / 2;
const TRANSFER_LAMPORTS = LAMPORTS_PER_SOL / 100;
const MIN_BALANCE_FOR_TX = LAMPORTS_PER_SOL / 50;

function loadOrCreateKeypair(): { kp: Keypair; isNew: boolean } {
  if (fs.existsSync(KEYPAIR_PATH)) {
    const secret = JSON.parse(fs.readFileSync(KEYPAIR_PATH, 'utf-8'));
    // Best-effort: re-tighten perms on an existing keypair in case it was
    // created by an older version of this script that used the default umask.
    try {
      fs.chmodSync(KEYPAIR_PATH, 0o600);
    } catch {
      /* chmod is a no-op on Windows; ignore. */
    }
    return { kp: Keypair.fromSecretKey(Uint8Array.from(secret)), isNew: false };
  }
  const kp = Keypair.generate();
  // MED-06: write the keypair with mode 0600 so it's only readable by the
  // file owner. Default umask on Linux/macOS produces 0644 (world-readable)
  // which is the wrong default for a secret key, even a devnet one.
  fs.writeFileSync(KEYPAIR_PATH, JSON.stringify(Array.from(kp.secretKey)), {
    encoding: 'utf-8',
    mode: 0o600,
  });
  return { kp, isNew: true };
}

async function tryAirdrop(conn: Connection, payer: Keypair): Promise<boolean> {
  try {
    const sig = await conn.requestAirdrop(payer.publicKey, AIRDROP_LAMPORTS);
    console.log(`  Airdrop signature: ${sig}`);
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      const status = await conn.getSignatureStatus(sig);
      const conf = status.value?.confirmationStatus;
      if (conf === 'confirmed' || conf === 'finalized') {
        console.log(`  Airdrop confirmed after ${i + 1}s`);
        return true;
      }
    }
    return false;
  } catch (err: any) {
    console.log(`  Airdrop failed: ${err.message?.split('\n')[0] ?? err}`);
    return false;
  }
}

async function buildAndWriteTx(conn: Connection, payer: Keypair): Promise<void> {
  const recipient = Keypair.generate();
  const { blockhash } = await conn.getLatestBlockhash('confirmed');
  const ix = SystemProgram.transfer({
    fromPubkey: payer.publicKey,
    toPubkey: recipient.publicKey,
    lamports: TRANSFER_LAMPORTS,
  });
  const msg = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: blockhash,
    instructions: [ix],
  }).compileToV0Message();
  const tx = new VersionedTransaction(msg);
  tx.sign([payer]);

  const b64 = Buffer.from(tx.serialize()).toString('base64');
  fs.writeFileSync(TX_OUT_PATH, b64, 'utf-8');

  console.log(`\nWrote ${TX_OUT_PATH} (${b64.length} chars)`);
  console.log(`Transaction: transfer ${TRANSFER_LAMPORTS / LAMPORTS_PER_SOL} SOL`);
  console.log(`  From: ${payer.publicKey.toBase58()}`);
  console.log(`  To:   ${recipient.publicKey.toBase58()}`);
  console.log(`\nSimulate it:`);
  console.log(`  open simulate ./test-tx.b64 --network devnet`);
}

async function main(): Promise<void> {
  const conn = new Connection(RPC, 'confirmed');
  const { kp: payer, isNew } = loadOrCreateKeypair();

  console.log(`RPC:    ${RPC}`);
  console.log(`Payer:  ${payer.publicKey.toBase58()}`);
  if (isNew) {
    console.log(`        (new keypair, saved to ${KEYPAIR_PATH})`);
  }

  const balance = await conn.getBalance(payer.publicKey);
  console.log(`Balance: ${balance / LAMPORTS_PER_SOL} SOL`);

  if (balance >= MIN_BALANCE_FOR_TX) {
    console.log(`\nPayer is already funded — building transaction...`);
    await buildAndWriteTx(conn, payer);
    return;
  }

  console.log(
    `\nPayer balance below ${MIN_BALANCE_FOR_TX / LAMPORTS_PER_SOL} SOL — attempting airdrop...`
  );
  const ok = await tryAirdrop(conn, payer);
  if (ok) {
    await buildAndWriteTx(conn, payer);
    return;
  }

  console.log(`\n⚠ Public ${NETWORK_LABEL} faucet is rate-limited or unavailable.`);
  console.log(`\nFund the payer manually (one-time, takes ~30s):`);
  console.log(`  1. Open https://faucet.solana.com`);
  console.log(`  2. Paste payer pubkey: ${payer.publicKey.toBase58()}`);
  console.log(`  3. Click "Devnet" + request 0.5 SOL`);
  console.log(`  4. Re-run this script: npx tsx scripts/generate-funded-test-tx.ts`);
  console.log(`\nThe keypair is persisted in ${KEYPAIR_PATH}, so you only fund once.`);
  process.exit(1);
}

main().catch((err) => {
  console.error('\nFailed:', err.message);
  process.exit(1);
});
