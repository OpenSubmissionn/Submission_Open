import path from 'node:path';
import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  eslint: { ignoreDuringBuilds: true },
  // @open/services ships as TypeScript source (its package `main` points at
  // src/index.ts), so Next must transpile it as part of the app build.
  transpilePackages: ['@open/services'],
  // transpilePackages bundles @open/services INTO the app output, so we don't
  // need to trace external files. Pin tracing to this package (NOT the monorepo
  // root) so Next doesn't infer the monorepo root during the build.
  outputFileTracingRoot: path.join(__dirname),
  webpack(config) {
    // @open/services is NodeNext TypeScript: its relative imports carry explicit
    // `.js` extensions that actually point at `.ts` sources. Teach webpack to try
    // the TS extensions first so those specifiers resolve during the app build.
    config.resolve.extensionAlias = {
      '.js': ['.ts', '.tsx', '.js'],
      '.jsx': ['.tsx', '.jsx'],
      '.mjs': ['.mts', '.mjs'],
    };
    return config;
  },
};

export default nextConfig;
