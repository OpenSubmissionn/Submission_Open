import type { ParsedInstruction, TokenInstruction } from '../types.js';
import { Buffer } from 'buffer';

/**
 * txParser normalises instruction data to lowercase hex, but RPC jsonParsed
 * paths can still hand us base64. Decode hex when the string is valid even-length
 * hex, otherwise fall back to base64 (mirrors decoders/anchor-idl.ts) — Jelleo F09.
 */
function decodeInstructionBytes(data: string): Buffer {
  if (data.length % 2 === 0 && /^[0-9a-fA-F]+$/.test(data)) {
    return Buffer.from(data, 'hex');
  }
  return Buffer.from(data, 'base64');
}

/**
 * Decodes SPL Token program instructions.
 * Returns null if instruction is not SPL Token related or cannot be decoded.
 */
export function decodeSPLInstruction(ix: ParsedInstruction): TokenInstruction | null {
  // If instruction is already parsed by RPC, convert to local format.
  if (ix.parsed) {
    return convertParsedToTokenInstruction(ix.parsed);
  }

  // No raw data means there is nothing to decode.
  if (!ix.data) {
    return null;
  }

  try {
    // Decode the payload (hex from txParser, or base64 from jsonParsed) into bytes.
    const dataBuffer = decodeInstructionBytes(ix.data);

    if (dataBuffer.length < 1) {
      return null;
    }

    // First byte identifies SPL Token instruction type.
    const instructionType = dataBuffer[0];

    // Route decoding by instruction type.
    switch (instructionType) {
      case 3: // Transfer
        return decodeTransfer(dataBuffer, ix.accounts);

      case 12: // TransferChecked
        return decodeTransferChecked(dataBuffer, ix.accounts);

      case 8: // MintTo
        return decodeMintTo(dataBuffer, ix.accounts);

      case 9: // Burn
        return decodeBurn(dataBuffer, ix.accounts);

      case 4: // Approve
        return decodeApprove(dataBuffer, ix.accounts);

      case 1: // InitializeAccount
        return decodeInitializeAccount(ix.accounts);

      case 0: // InitializeMint
        return decodeInitializeMint(dataBuffer, ix.accounts);

      default:
        // Unknown type: return raw payload for downstream inspection.
        return {
          instructionName: 'unknown',
          rawData: ix.data,
        };
    }
  } catch (error) {
    console.error('Error decoding SPL Token instruction:', error);
    return {
      instructionName: 'unknown',
      rawData: ix.data,
    };
  }
}

/**
 * Convert pre-decoded instruction to TokenInstruction format
 */
function convertParsedToTokenInstruction(parsed: any): TokenInstruction | null {
  if (!parsed.type) {
    return null;
  }

  const info = parsed.info || {};

  return {
    instructionName: parsed.type,
    source: info.source,
    destination: info.destination,
    mint: info.mint,
    authority: info.authority,
    amount: info.tokenAmount?.amount || info.amount,
    decimals: info.tokenAmount?.decimals ?? info.decimals,
  };
}

/**
 * Decode Transfer instruction (type 3)
 * Structure:
 * - byte 0: instruction type (3)
 * - bytes 1-8: amount (u64, little-endian)
 * - bytes 9+: optional data
 */
function decodeTransfer(data: Buffer, accounts: ParsedInstruction['accounts']): TokenInstruction {
  const amount = data.length >= 9 ? data.readBigUInt64LE(1).toString() : '0';

  return {
    instructionName: 'transfer',
    source: accounts[0], // Token account (from)
    destination: accounts[1], // Token account (to)
    authority: accounts[2], // Owner/signer
    amount: amount,
  };
}

/**
 * Decode TransferChecked instruction (type 12)
 * Structure:
 * - byte 0: instruction type (12)
 * - bytes 1-8: amount (u64, little-endian)
 * - byte 9: decimals (u8)
 */
function decodeTransferChecked(
  data: Buffer,
  accounts: ParsedInstruction['accounts']
): TokenInstruction {
  const amount = data.length >= 9 ? data.readBigUInt64LE(1).toString() : '0';
  const decimals = data.length >= 10 ? data[9] : undefined;

  return {
    instructionName: 'transferChecked',
    source: accounts[0],
    mint: accounts[1],
    destination: accounts[2],
    authority: accounts[3],
    amount,
    decimals,
  };
}

/**
 * Decode MintTo instruction (type 8)
 * Structure:
 * - byte 0: instruction type (8)
 * - bytes 1-8: amount (u64, little-endian)
 */
function decodeMintTo(data: Buffer, accounts: ParsedInstruction['accounts']): TokenInstruction {
  const amount = data.length >= 9 ? data.readBigUInt64LE(1).toString() : '0';

  return {
    instructionName: 'mintTo',
    mint: accounts[0], // Token mint
    destination: accounts[1], // Destination account
    authority: accounts[2], // Mint authority
    amount: amount,
  };
}

/**
 * Decode Burn instruction (type 9)
 * Structure:
 * - byte 0: instruction type (9)
 * - bytes 1-8: amount (u64, little-endian)
 */
function decodeBurn(data: Buffer, accounts: ParsedInstruction['accounts']): TokenInstruction {
  const amount = data.length >= 9 ? data.readBigUInt64LE(1).toString() : '0';

  return {
    instructionName: 'burn',
    source: accounts[0], // Token account being burned
    mint: accounts[1], // Token mint
    authority: accounts[2], // Owner/signer
    amount: amount,
  };
}

/**
 * Decode Approve instruction (type 4)
 * Structure:
 * - byte 0: instruction type (4)
 * - bytes 1-8: amount (u64, little-endian)
 */
function decodeApprove(data: Buffer, accounts: ParsedInstruction['accounts']): TokenInstruction {
  const amount = data.length >= 9 ? data.readBigUInt64LE(1).toString() : '0';

  return {
    instructionName: 'approve',
    source: accounts[0], // Token account
    authority: accounts[1], // Owner/signer
    destination: accounts[2], // Delegate (approved to spend)
    amount: amount,
  };
}

/**
 * Decode InitializeAccount instruction (type 1)
 * No amount data, just sets up the account
 */
function decodeInitializeAccount(accounts: ParsedInstruction['accounts']): TokenInstruction {
  return {
    instructionName: 'initializeAccount',
    destination: accounts[0], // Token account being initialized
    mint: accounts[1], // Token mint
    authority: accounts[2], // Owner
  };
}

/**
 * Decode InitializeMint instruction (type 0)
 * Structure:
 * - byte 0: instruction type (0)
 * - byte 1: decimals (u8)
 * - bytes 2-33: owner (Pubkey)
 * - bytes 34-65: freeze_authority (Pubkey, optional)
 */
function decodeInitializeMint(
  data: Buffer,
  accounts: ParsedInstruction['accounts']
): TokenInstruction {
  const decimals = data.length >= 2 ? data[1] : undefined;

  return {
    instructionName: 'initializeMint',
    mint: accounts[0], // Token mint
    authority: accounts[1], // Mint authority
    decimals: decimals,
  };
}
