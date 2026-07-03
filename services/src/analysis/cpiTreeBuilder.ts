export interface ExecutionError {
  rawMessage: string;
  code?: string;
}

export interface ExecutionSnapshot {
  programId: string;
  depth: number;
  status: 'success' | 'failed' | 'truncated';
  logs: string[];
  dataLogs: string[];
  computeUnitsConsumed?: number;
  error?: ExecutionError;
  children: ExecutionSnapshot[];
}

export interface ExecutionTrace {
  roots: ExecutionSnapshot[];
  totalComputeUnits: number;
  isTruncated: boolean;
}

const REGEX = {
  INVOKE: /^Program (\w+) invoke \[(\d+)\]$/,
  SUCCESS: /^Program (\w+) success$/,
  FAILED: /^Program (\w+) failed: (.*)$/,
  CU: /^Program (\w+) consumed (\d+) of \d+ compute units$/,
  LOG: /^Program log: (.*)$/,
  DATA: /^Program (?:data|return): (.*)$/,
};

function createNode(programId: string, depth: number): ExecutionSnapshot {
  return {
    programId,
    depth,
    status: 'truncated',
    logs: [],
    dataLogs: [],
    children: [],
  };
}

function markTruncated(node: ExecutionSnapshot): void {
  node.status = 'truncated';
}

function popOpenNodesUntilDepth(
  stack: ExecutionSnapshot[],
  nextDepth: number,
  trace: ExecutionTrace
): void {
  while (stack.length > 0 && stack[stack.length - 1].depth >= nextDepth) {
    const node = stack.pop()!;
    markTruncated(node);
    trace.isTruncated = true;
  }
}

function findMatchingOpenNode(stack: ExecutionSnapshot[], programId: string): number {
  for (let index = stack.length - 1; index >= 0; index--) {
    if (stack[index].programId === programId) return index;
  }
  return -1;
}

function truncateNodesAbove(
  stack: ExecutionSnapshot[],
  matchIndex: number,
  trace: ExecutionTrace
): void {
  while (stack.length - 1 > matchIndex) {
    const node = stack.pop()!;
    markTruncated(node);
    trace.isTruncated = true;
  }
}

export function buildCPITree(logMessages: string[]): ExecutionTrace {
  const trace: ExecutionTrace = {
    roots: [],
    totalComputeUnits: 0,
    isTruncated: false,
  };
  const stack: ExecutionSnapshot[] = [];

  for (const line of logMessages) {
    const invokeMatch = line.match(REGEX.INVOKE);
    if (invokeMatch) {
      const programId = invokeMatch[1];
      const depth = parseInt(invokeMatch[2], 10);

      popOpenNodesUntilDepth(stack, depth, trace);

      if (stack.length < depth - 1) trace.isTruncated = true;

      const node = createNode(programId, depth);

      if (stack.length === 0) trace.roots.push(node);
      else stack[stack.length - 1].children.push(node);

      stack.push(node);
      continue;
    }

    if (stack.length === 0) continue;
    const activeNode = stack[stack.length - 1];

    const logMatch = line.match(REGEX.LOG);
    if (logMatch) {
      activeNode.logs.push(logMatch[1]);
      continue;
    }

    const dataMatch = line.match(REGEX.DATA);
    if (dataMatch) {
      activeNode.dataLogs.push(dataMatch[1]);
      continue;
    }

    const cuMatch = line.match(REGEX.CU);
    if (cuMatch) {
      const matchedIndex = findMatchingOpenNode(stack, cuMatch[1]);
      if (matchedIndex === -1) continue;
      truncateNodesAbove(stack, matchedIndex, trace);
      const matchedNode = stack[matchedIndex];
      const consumed = parseInt(cuMatch[2], 10);
      if (matchedNode.computeUnitsConsumed === undefined) {
        matchedNode.computeUnitsConsumed = consumed;
        // Do NOT accumulate here: a parent's reported CU already includes its
        // CPI children. The transaction total is summed from root nodes below.
      }
      continue;
    }

    const successMatch = line.match(REGEX.SUCCESS);
    if (successMatch) {
      const matchedIndex = findMatchingOpenNode(stack, successMatch[1]);
      if (matchedIndex === -1) continue;
      truncateNodesAbove(stack, matchedIndex, trace);
      stack[matchedIndex].status = 'success';
      stack.pop();
      continue;
    }

    const failedMatch = line.match(REGEX.FAILED);
    if (failedMatch) {
      const matchedIndex = findMatchingOpenNode(stack, failedMatch[1]);
      if (matchedIndex === -1) continue;
      truncateNodesAbove(stack, matchedIndex, trace);
      const matchedNode = stack[matchedIndex];
      matchedNode.status = 'failed';
      matchedNode.error = { rawMessage: failedMatch[2] };
      const codeMatch = failedMatch[2].match(/custom program error: (0x[0-9a-fA-F]+|\d+)/);
      if (codeMatch) matchedNode.error.code = codeMatch[1];
      stack.pop();
      continue;
    }
  }

  if (stack.length > 0) {
    trace.isTruncated = true;
    while (stack.length > 0) markTruncated(stack.pop()!);
  }

  // A root program's reported CU already includes its entire CPI subtree, so
  // the transaction total is the sum of the ROOTS' consumed CU — summing every
  // node would double-count nested CPIs (Jelleo F01).
  trace.totalComputeUnits = trace.roots.reduce(
    (sum, root) => sum + (root.computeUnitsConsumed ?? 0),
    0
  );

  return trace;
}
