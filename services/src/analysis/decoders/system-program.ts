import type { ParsedInstruction, SystemInstruction } from '../types.js';

/**
 * System Program instruction discriminators (u32 little-endian).
 * Reference: https://github.com/solana-labs/solana/blob/master/sdk/program/src/system_instruction.rs
 */
const SYSTEM_INSTRUCTION_DISCRIMINATORS = {
  CREATE_ACCOUNT: 0,
  ASSIGN: 1,
  TRANSFER: 2,
  CREATE_ACCOUNT_WITH_SEED: 3,
  ADVANCE_NONCE_ACCOUNT: 4,
  WITHDRAW_NONCE_ACCOUNT: 5,
  INITIALIZE_NONCE_ACCOUNT: 6,
  AUTHORIZE_NONCE_ACCOUNT: 7,
  ALLOCATE: 8,
  ALLOCATE_WITH_SEED: 9,
  ASSIGN_WITH_SEED: 10,
  TRANSFER_WITH_SEED: 11,
  UPGRADE_NONCE_ACCOUNT: 12,
} as const;

/**
 * Decodes a System Program instruction from base64-encoded data.
 * Supports: CreateAccount, Assign, Transfer, Allocate, and other System Program instructions.
 *
 * @param ix - Parsed instruction containing base64-encoded data and accounts
 * @returns Decoded SystemInstruction or null if decoding fails
 */
export function decodeSystemInstruction(ix: ParsedInstruction): SystemInstruction | null {
  if (!ix?.data || !ix?.accounts) {
    return null;
  }

  try {
    // System Program data arrives as base64 from the Solana RPC.
    const buffer = Buffer.from(ix.data, 'base64');

    // Ensure buffer has at least 4 bytes for discriminator
    if (buffer.length < 4) {
      return null;
    }

    // Read u32 little-endian discriminator from first 4 bytes
    const discriminator = buffer.readUInt32LE(0);

    let result: SystemInstruction | null = null;

    switch (discriminator) {
      case SYSTEM_INSTRUCTION_DISCRIMINATORS.CREATE_ACCOUNT:
        result = decodeCreateAccount(buffer, ix.accounts);
        break;

      case SYSTEM_INSTRUCTION_DISCRIMINATORS.ASSIGN:
        result = decodeAssign(buffer, ix.accounts);
        break;

      case SYSTEM_INSTRUCTION_DISCRIMINATORS.TRANSFER:
        result = decodeTransfer(buffer, ix.accounts);
        break;

      case SYSTEM_INSTRUCTION_DISCRIMINATORS.CREATE_ACCOUNT_WITH_SEED:
        result = decodeCreateAccountWithSeed(buffer, ix.accounts);
        break;

      case SYSTEM_INSTRUCTION_DISCRIMINATORS.ALLOCATE:
        result = decodeAllocate(buffer, ix.accounts);
        break;

      case SYSTEM_INSTRUCTION_DISCRIMINATORS.ADVANCE_NONCE_ACCOUNT:
        result = decodeAdvanceNonceAccount(buffer, ix.accounts);
        break;

      case SYSTEM_INSTRUCTION_DISCRIMINATORS.WITHDRAW_NONCE_ACCOUNT:
        result = decodeWithdrawNonceAccount(buffer, ix.accounts);
        break;

      case SYSTEM_INSTRUCTION_DISCRIMINATORS.INITIALIZE_NONCE_ACCOUNT:
        result = decodeInitializeNonceAccount(buffer, ix.accounts);
        break;

      default:
        // Unknown System Program instruction
        return {
          instructionName: `Unknown (${discriminator})`,
          rawData: ix.data,
        };
    }

    // Always include rawData
    if (result) {
      result.rawData = ix.data;
    }

    return result;
  } catch {
    // Return null on any parsing errors
    return null;
  }
}

/**
 * CreateAccount (0): Creates a new account and allocates space.
 * Layout: [discriminator: u32][lamports: u64][space: u64][owner: Pubkey(32)]
 */
function decodeCreateAccount(buffer: Buffer, accounts: string[]): SystemInstruction | null {
  // Minimum: 4 (disc) + 8 (lamports) + 8 (space) + 32 (owner) = 52 bytes
  if (buffer.length < 52) {
    return null;
  }

  const lamports = Number(buffer.readBigUInt64LE(4));
  const space = Number(buffer.readBigUInt64LE(12));
  const owner = buffer.slice(20, 52).toString('hex');

  return {
    instructionName: 'CreateAccount',
    fromPubkey: accounts[0],
    newAccountPubkey: accounts[1],
    lamports,
    space,
    owner,
  };
}

/**
 * Assign (1): Assigns an account to a program.
 * Layout: [discriminator: u32][owner: Pubkey(32)]
 */
function decodeAssign(buffer: Buffer, accounts: string[]): SystemInstruction | null {
  // Minimum: 4 (disc) + 32 (owner) = 36 bytes
  if (buffer.length < 36) {
    return null;
  }

  const owner = buffer.slice(4, 36).toString('hex');

  return {
    instructionName: 'Assign',
    toPubkey: accounts[0],
    owner,
  };
}

/**
 * Transfer (2): Transfers lamports between two accounts.
 * Layout: [discriminator: u32][lamports: u64]
 */
function decodeTransfer(buffer: Buffer, accounts: string[]): SystemInstruction | null {
  // Minimum: 4 (disc) + 8 (lamports) = 12 bytes
  if (buffer.length < 12) {
    return null;
  }

  const lamports = Number(buffer.readBigUInt64LE(4));

  return {
    instructionName: 'Transfer',
    fromPubkey: accounts[0],
    toPubkey: accounts[1],
    lamports,
  };
}

/**
 * CreateAccountWithSeed (3): Creates account at a derived address.
 * Layout: [discriminator: u32][base: Pubkey(32)][seed_len: u32][seed: string][lamports: u64][space: u64][owner: Pubkey(32)]
 */
function decodeCreateAccountWithSeed(buffer: Buffer, accounts: string[]): SystemInstruction | null {
  // Minimum: 4 (disc) + 32 (base) + 4 (seed_len) + 8 (lamports) + 8 (space) + 32 (owner) = 88 bytes
  if (buffer.length < 88) {
    return null;
  }

  const seedLen = buffer.readUInt32LE(36);
  const seedOffset = 40;

  if (buffer.length < seedOffset + seedLen + 16 + 32) {
    return null;
  }
  const lamportsOffset = seedOffset + seedLen;
  const lamports = Number(buffer.readBigUInt64LE(lamportsOffset));
  const space = Number(buffer.readBigUInt64LE(lamportsOffset + 8));
  const owner = buffer.slice(lamportsOffset + 16, lamportsOffset + 48).toString('hex');

  return {
    instructionName: 'CreateAccountWithSeed',
    newAccountPubkey: accounts[0],
    fromPubkey: accounts[1],
    lamports,
    space,
    owner,
  };
}

/**
 * Allocate (8): Allocates space for data on an account.
 * Layout: [discriminator: u32][space: u64]
 */
function decodeAllocate(buffer: Buffer, accounts: string[]): SystemInstruction | null {
  // Minimum: 4 (disc) + 8 (space) = 12 bytes
  if (buffer.length < 12) {
    return null;
  }

  const space = Number(buffer.readBigUInt64LE(4));

  return {
    instructionName: 'Allocate',
    newAccountPubkey: accounts[0],
    space,
  };
}

/**
 * AdvanceNonceAccount (4): Advances a nonce account.
 * Layout: [discriminator: u32][authorized_pubkey: Pubkey(32)]
 */
function decodeAdvanceNonceAccount(buffer: Buffer, accounts: string[]): SystemInstruction | null {
  // Minimum: 4 (disc) + 32 (authorized) = 36 bytes
  if (buffer.length < 36) {
    return null;
  }

  const authorized = buffer.slice(4, 36).toString('hex');

  return {
    instructionName: 'AdvanceNonceAccount',
    toPubkey: accounts[0],
    owner: authorized,
  };
}

/**
 * WithdrawNonceAccount (5): Withdraws from a nonce account.
 * Layout: [discriminator: u32][lamports: u64]
 */
function decodeWithdrawNonceAccount(buffer: Buffer, accounts: string[]): SystemInstruction | null {
  // Minimum: 4 (disc) + 8 (lamports) = 12 bytes
  if (buffer.length < 12) {
    return null;
  }

  const lamports = Number(buffer.readBigUInt64LE(4));

  return {
    instructionName: 'WithdrawNonceAccount',
    toPubkey: accounts[0],
    fromPubkey: accounts[1],
    lamports,
  };
}

/**
 * InitializeNonceAccount (6): Initializes a nonce account.
 * Layout: [discriminator: u32][authorized: Pubkey(32)]
 */
function decodeInitializeNonceAccount(
  buffer: Buffer,
  accounts: string[]
): SystemInstruction | null {
  // Minimum: 4 (disc) + 32 (authorized) = 36 bytes
  if (buffer.length < 36) {
    return null;
  }

  const authorized = buffer.slice(4, 36).toString('hex');

  return {
    instructionName: 'InitializeNonceAccount',
    newAccountPubkey: accounts[0],
    owner: authorized,
  };
}
