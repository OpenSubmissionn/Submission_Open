import programsData from '../data/programs.json' with { type: 'json' };
import axios from 'axios';

// Simple in-memory cache to avoid redundant API calls during a single session.
const apiCache = new Map<string, any>();

/**
 * Fetches program/token metadata from the Helius API.
 *
 * The API key travels in the Authorization header instead of the URL query
 * string so it doesn't leak into access logs, proxy caches, or axios error
 * objects (which serialize `config.url`). Helius supports both, but only the
 * header form is safe by default.
 *
 * @param programId - The program or token mint address.
 * @param apiKey - The Helius API key.
 * @returns The program info or null if not found.
 */
async function fetchProgramInfoFromAPI(programId: string, apiKey: string): Promise<any | null> {
  if (apiCache.has(programId)) {
    return apiCache.get(programId);
  }

  try {
    const { data } = await axios.post(
      'https://api.helius.xyz/v0/token-metadata',
      { mintAccounts: [programId], includeOffChain: true },
      { headers: { Authorization: `Bearer ${apiKey}` } }
    );

    if (data && data.length > 0 && data[0].onChainAccountInfo) {
      const metadata = data[0];
      const info = {
        name:
          metadata.offChainMetadata?.metadata?.name ||
          metadata.onChainMetadata?.metadata?.data?.name ||
          'Unknown',
        category: 'token', // Assume 'token' for now from this endpoint
        description: metadata.offChainMetadata?.metadata?.description || '',
      };
      apiCache.set(programId, info);
      return info;
    }
    apiCache.set(programId, null); // Cache the fact that it wasn't found
    return null;
  } catch (error) {
    // Don't log errors for not found, but log other potential issues. Only the
    // status + message are logged — never the request URL or headers, since
    // axios includes the Authorization header on `error.config.headers` and a
    // verbose console dump could leak the key through CI/server logs.
    if (axios.isAxiosError(error) && error.response?.status !== 404) {
      console.error(
        `Helius API error (HTTP ${error.response?.status ?? 'network'}): ${error.message}`
      );
    }
    apiCache.set(programId, null);
    return null;
  }
}

/**
 * Get human-readable name for a Solana program ID.
 * It first checks the local JSON file and then falls back to an API call.
 *
 * @param programId - The program ID (public key as string)
 * @returns Program name or "Unknown Program" if not found
 */
export async function getProgramName(programId: string): Promise<string> {
  const localProgram = programsData[programId as keyof typeof programsData];
  if (localProgram) {
    return localProgram.name;
  }

  const apiKey = process.env.HELIUS_API_KEY;
  if (apiKey) {
    const apiProgram = await fetchProgramInfoFromAPI(programId, apiKey);
    if (apiProgram) {
      return apiProgram.name;
    }
  }

  return 'Unknown Program';
}

/**
 * Synchronous program name lookup for parsing hot paths.
 * This only uses the local registry and never performs network calls.
 */
export function getProgramNameSync(programId: string): string {
  const localProgram = programsData[programId as keyof typeof programsData];
  return localProgram?.name ?? 'Unknown Program';
}

/**
 * Get full program info (name + category + description).
 * It first checks the local JSON file and then falls back to an API call.
 *
 * @param programId - The program ID
 * @returns Program info object or null if not found
 */
export async function getProgramInfo(
  programId: string
): Promise<{ name: string; category: string; description: string } | null> {
  const program = programsData[programId as keyof typeof programsData];
  if (program) {
    return program;
  }

  const apiKey = process.env.HELIUS_API_KEY;
  if (apiKey) {
    return fetchProgramInfoFromAPI(programId, apiKey);
  }

  return null;
}

/**
 * Check if a program ID is known
 *
 * @param programId - The program ID
 * @returns true if program exists in registry, false otherwise
 */
export function isProgramKnown(programId: string): boolean {
  return programId in programsData;
}

/**
 * Get all programs in a category
 *
 * @param category - The category (e.g., "defi", "nft", "system")
 * @returns Array of program IDs in that category
 */
export function getProgramsByCategory(category: string): string[] {
  return Object.entries(programsData)
    .filter(([_, program]) => program.category === category)
    .map(([id, _]) => id);
}

export default programsData;
