// bs58@4.x ships no type declarations. We only use the default export's
// encode/decode, so declare a minimal shape here rather than pulling in
// @types/bs58 (which targets a different major).
declare module 'bs58' {
  const bs58: {
    encode(data: Uint8Array | number[]): string;
    decode(str: string): Uint8Array;
  };
  export default bs58;
}
