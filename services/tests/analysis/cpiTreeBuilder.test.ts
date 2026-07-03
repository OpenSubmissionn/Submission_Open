import { describe, it, expect } from 'vitest';
import { buildCPITree } from '../../src/analysis/cpiTreeBuilder';

describe('CPI Tree Builder', () => {
  it('1. Should process a deep tree with multiple children and mixed errors', () => {
    const massiveLogs = [
      'Program 1111 invoke [1]',
      'Program log: Starting main transaction',
      'Program 2222 invoke [2]',
      'Program log: Child 1 processing',
      'Program 2222 consumed 500 of 200000 compute units',
      'Program 2222 success',
      'Program 3333 invoke [2]',
      'Program log: Child 2 started',
      'Program 4444 invoke [3]',
      'Program data: base64/xxx=',
      'Program 4444 consumed 1000 of 200000 compute units',
      'Program 4444 success',
      'Program 3333 failed: custom program error: 0x10',
      'Program 1111 consumed 5000 of 200000 compute units',
      'Program 1111 failed: custom program error: 0x1',
    ];

    const trace = buildCPITree(massiveLogs);

    // Root 1111 reports 5000 CU; that value already includes its CPI subtree
    // (children 2222/4444). Summing all nodes would double-count → 6500 (Jelleo F01).
    expect(trace.totalComputeUnits).toBe(5000);
    expect(trace.isTruncated).toBe(false);
    expect(trace.roots.length).toBe(1);

    const root = trace.roots[0];
    expect(root.programId).toBe('1111');
    expect(root.status).toBe('failed');
    expect(root.children.length).toBe(2);

    const child1 = root.children[0];
    expect(child1.programId).toBe('2222');
    expect(child1.status).toBe('success');
    expect(child1.computeUnitsConsumed).toBe(500);

    const child2 = root.children[1];
    expect(child2.programId).toBe('3333');
    expect(child2.status).toBe('failed');
    expect(child2.error?.code).toBe('0x10');
    expect(child2.children.length).toBe(1);

    const grandson = child2.children[0];
    expect(grandson.programId).toBe('4444');
    expect(grandson.depth).toBe(3);
    expect(grandson.status).toBe('success');
  });

  it('2. Should mark the tree as truncated if logs are cut by the RPC', () => {
    const truncatedLogs = [
      'Program AAAA invoke [1]',
      'Program log: We are doing something heavy...',
      'Program BBBB invoke [2]',
      'Program log: It will cut now...',
    ];

    const trace = buildCPITree(truncatedLogs);

    expect(trace.isTruncated).toBe(true);
    expect(trace.roots[0].status).toBe('truncated');
    expect(trace.roots[0].children[0].programId).toBe('BBBB');
    expect(trace.roots[0].children[0].status).toBe('truncated');
  });

  it('3. Should handle immediate failures without CU consumption', () => {
    const fastFailLogs = ['Program FFFF invoke [1]', 'Program FFFF failed: invalid account data'];

    const trace = buildCPITree(fastFailLogs);

    expect(trace.totalComputeUnits).toBe(0);
    expect(trace.roots[0].status).toBe('failed');
    expect(trace.roots[0].error?.rawMessage).toBe('invalid account data');
    expect(trace.roots[0].error?.code).toBeUndefined();
  });

  it('4. Should close open nodes as truncated when a new invoke at the same depth appears', () => {
    const repeatedDepthLogs = [
      'Program Root invoke [1]',
      'Program ChildA invoke [2]',
      'Program log: Child A stayed open',
      'Program ChildB invoke [2]',
      'Program ChildB consumed 120 of 200000 compute units',
      'Program ChildB success',
      'Program Root consumed 500 of 200000 compute units',
      'Program Root success',
    ];

    const trace = buildCPITree(repeatedDepthLogs);

    expect(trace.isTruncated).toBe(true);
    // Root consumed 500; ChildB's 120 CU is already included in the root's reported total.
    expect(trace.totalComputeUnits).toBe(500);
    expect(trace.roots).toHaveLength(1);

    const root = trace.roots[0];
    expect(root.status).toBe('success');
    expect(root.children).toHaveLength(2);
    expect(root.children[0].programId).toBe('ChildA');
    expect(root.children[0].status).toBe('truncated');
    expect(root.children[1].programId).toBe('ChildB');
    expect(root.children[1].status).toBe('success');
  });

  it('5. Should maintain consistency in deep CPI with partial closing', () => {
    const deepLogs = [
      'Program Root invoke [1]',
      'Program Level1 invoke [2]',
      'Program Level2 invoke [3]',
      'Program Level3 invoke [4]',
      'Program Level3 consumed 70 of 200000 compute units',
      'Program Level3 success',
      'Program Level2 consumed 80 of 200000 compute units',
      'Program Level2 success',
      'Program Level1 consumed 90 of 200000 compute units',
      'Program Level1 success',
      'Program Root consumed 100 of 200000 compute units',
      'Program Root success',
    ];

    const trace = buildCPITree(deepLogs);

    expect(trace.isTruncated).toBe(false);
    // Root reports 100 CU; Level1/Level2/Level3 CU are already included in that total.
    // Summing all nodes (100+90+80+70=340) would double-count nested CPIs (Jelleo F01).
    expect(trace.totalComputeUnits).toBe(100);
    expect(trace.roots[0].children[0].children[0].children[0].programId).toBe('Level3');
    expect(trace.roots[0].status).toBe('success');
  });

  it('6. Should preserve partial failure without losing the rest of the tree', () => {
    const partialFailureLogs = [
      'Program Router invoke [1]',
      'Program SwapA invoke [2]',
      'Program SwapA failed: insufficient balance',
      'Program SwapB invoke [2]',
      'Program SwapB consumed 200 of 200000 compute units',
      'Program SwapB success',
      'Program Router consumed 300 of 200000 compute units',
      'Program Router success',
    ];

    const trace = buildCPITree(partialFailureLogs);

    expect(trace.isTruncated).toBe(false);
    // Router root reports 300 CU; SwapB's 200 is already contained in that total.
    // Summing all nodes (300+200=500) would double-count nested CPIs (Jelleo F01).
    expect(trace.totalComputeUnits).toBe(300);
    expect(trace.roots[0].status).toBe('success');
    expect(trace.roots[0].children).toHaveLength(2);
    expect(trace.roots[0].children[0].status).toBe('failed');
    expect(trace.roots[0].children[1].status).toBe('success');
    expect(trace.roots[0].children[0].error?.rawMessage).toBe('insufficient balance');
  });
});
