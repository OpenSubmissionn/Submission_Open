'use client';

import { useState } from 'react';

const INSTALL_CMD = 'npm install -g opendevtool';

// Click-to-copy install command, matching the deployed landing hint.
export function InstallLine(): React.JSX.Element {
  const [copied, setCopied] = useState(false);

  async function handleCopy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(INSTALL_CMD);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      // Clipboard blocked — silently no-op, matching the source behaviour.
    }
  }

  return (
    <button
      type="button"
      className="install-line"
      title="Click to copy"
      onClick={() => void handleCopy()}
    >
      <span className="prompt">$</span>
      <span className="mono">{INSTALL_CMD}</span>
      <span className="copy" style={copied ? { color: 'var(--green)' } : undefined}>
        {copied ? 'copied ✓' : 'copy'}
      </span>
    </button>
  );
}
