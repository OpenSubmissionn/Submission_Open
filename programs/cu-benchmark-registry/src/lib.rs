use anchor_lang::prelude::*;

declare_id!("BUCaknZAQ6HSqgeBDZ1taxjLXfWMHRcmaZdHhHjh9d1R");

#[program]
pub mod cu_benchmark_registry {
    use super::*;

    /// Create the benchmark entry for `(program_id, instruction_hash)` seeded with
    /// its first compute-unit sample. The `init` constraint makes this fail if the
    /// entry already exists, so callers fall back to `update_benchmark`.
    pub fn init_benchmark(
        ctx: Context<InitBenchmark>,
        program_id: Pubkey,
        instruction_hash: [u8; 8],
        cu_sample: u64,
    ) -> Result<()> {
        let entry = &mut ctx.accounts.benchmark;
        entry.program_id = program_id;
        entry.instruction_hash = instruction_hash;
        entry.p50_cu = cu_sample;
        entry.sample_count = 1;
        entry.last_updated = Clock::get()?.unix_timestamp;
        entry.bump = ctx.bumps.benchmark;

        emit!(BenchmarkInitialized {
            program_id,
            instruction_hash,
            p50_cu: cu_sample,
        });

        Ok(())
    }

    /// Fold a new CU sample into an existing entry with a 10-sample EMA:
    /// `new_p50 = (old_p50 * 9 + cu_sample) / 10`. Permissionless telemetry — any
    /// signer may contribute a sample; there is no authority restriction.
    pub fn update_benchmark(ctx: Context<UpdateBenchmark>, cu_sample: u64) -> Result<()> {
        let entry = &mut ctx.accounts.benchmark;

        let blended = entry
            .p50_cu
            .checked_mul(9)
            .ok_or(BenchmarkError::Overflow)?
            .checked_add(cu_sample)
            .ok_or(BenchmarkError::Overflow)?
            .checked_div(10)
            .ok_or(BenchmarkError::DivisionByZero)?;

        entry.p50_cu = blended;
        entry.sample_count = entry
            .sample_count
            .checked_add(1)
            .ok_or(BenchmarkError::Overflow)?;
        entry.last_updated = Clock::get()?.unix_timestamp;

        emit!(BenchmarkUpdated {
            program_id: entry.program_id,
            instruction_hash: entry.instruction_hash,
            p50_cu: entry.p50_cu,
            sample_count: entry.sample_count,
        });

        Ok(())
    }
}

#[derive(Accounts)]
#[instruction(program_id: Pubkey, instruction_hash: [u8; 8])]
pub struct InitBenchmark<'info> {
    #[account(
        init,
        payer = submitter,
        space = BenchmarkEntry::DISCRIMINATOR.len() + BenchmarkEntry::INIT_SPACE,
        seeds = [b"benchmark", program_id.as_ref(), instruction_hash.as_ref()],
        bump
    )]
    pub benchmark: Account<'info, BenchmarkEntry>,

    #[account(mut)]
    pub submitter: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdateBenchmark<'info> {
    #[account(
        mut,
        seeds = [
            b"benchmark",
            benchmark.program_id.as_ref(),
            benchmark.instruction_hash.as_ref(),
        ],
        bump = benchmark.bump,
    )]
    pub benchmark: Account<'info, BenchmarkEntry>,

    pub submitter: Signer<'info>,
}

/// One benchmark record, keyed by `(program_id, instruction_hash)`.
#[account]
#[derive(InitSpace)]
pub struct BenchmarkEntry {
    /// The program whose instruction is being benchmarked.
    pub program_id: Pubkey,
    /// First 8 bytes of `sha256(instruction_name)`.
    pub instruction_hash: [u8; 8],
    /// 10-sample EMA of measured compute units (the "typical" cost).
    pub p50_cu: u64,
    /// Total number of samples folded into this entry.
    pub sample_count: u64,
    /// Unix timestamp of the last update.
    pub last_updated: i64,
    /// Canonical PDA bump, stored so it is never recomputed.
    pub bump: u8,
}

#[event]
pub struct BenchmarkInitialized {
    pub program_id: Pubkey,
    pub instruction_hash: [u8; 8],
    pub p50_cu: u64,
}

#[event]
pub struct BenchmarkUpdated {
    pub program_id: Pubkey,
    pub instruction_hash: [u8; 8],
    pub p50_cu: u64,
    pub sample_count: u64,
}

#[error_code]
pub enum BenchmarkError {
    #[msg("Arithmetic overflow occurred")]
    Overflow,
    #[msg("Division by zero")]
    DivisionByZero,
}
