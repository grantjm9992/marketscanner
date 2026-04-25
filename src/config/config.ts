import { z } from 'zod';

const NumStr = z
  .string()
  .transform((s) => Number(s))
  .pipe(z.number());

const IntStr = z
  .string()
  .transform((s) => Number.parseInt(s, 10))
  .pipe(z.number().int());

const BoolStr = z
  .string()
  .transform((s) => s.toLowerCase() === 'true' || s === '1')
  .pipe(z.boolean());

const StrategyParamsStr = z.string().transform((s, ctx) => {
  if (s.trim() === '') return {};
  try {
    return JSON.parse(s) as Record<string, unknown>;
  } catch {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'STRATEGY_PARAMS must be valid JSON' });
    return z.NEVER;
  }
});

const MarketsStr = z
  .string()
  .transform((s) =>
    s
      .split(',')
      .map((x) => x.trim())
      .filter((x) => x.length > 0),
  )
  .pipe(z.array(z.string()));

const EnvSchema = z.object({
  MODE: z.enum(['live', 'paper', 'backtest']),

  POLYMARKET_CLOB_HOST: z.string().url(),
  POLYMARKET_WS_HOST: z.string().url(),
  POLYMARKET_CHAIN_ID: IntStr.default('137'),
  POLYMARKET_PRIVATE_KEY: z.string().optional(),

  DATABASE_PATH: z.string().default('./data/bot.db'),

  RISK_MAX_POSITION_USD: NumStr.pipe(z.number().positive()),
  RISK_MAX_TOTAL_DEPLOYED_USD: NumStr.pipe(z.number().positive()),
  RISK_MAX_DAILY_LOSS_USD: NumStr.pipe(z.number().positive()),
  RISK_MAX_ORDERS_PER_MINUTE: IntStr.default('30').pipe(z.number().int().positive()),
  RISK_PER_MARKET_COOLDOWN_MS: IntStr.default('60000').pipe(z.number().int().nonnegative()),
  RISK_MAX_OPEN_ORDERS_PER_MARKET: IntStr.default('4').pipe(z.number().int().positive()),

  SIMULATOR_LATENCY_MS: IntStr.default('250').pipe(z.number().int().nonnegative()),
  SIMULATOR_STARTING_CASH_USD: NumStr.default('1000').pipe(z.number().positive()),

  STRATEGY_NAME: z.string().min(1),
  STRATEGY_MARKETS: MarketsStr,
  STRATEGY_PARAMS: StrategyParamsStr.default('{}'),

  RECORD_SNAPSHOTS: BoolStr.default('true'),

  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error']).default('info'),
});

export interface Config {
  readonly mode: 'live' | 'paper' | 'backtest';
  readonly polymarket: {
    readonly clobHost: string;
    readonly wsHost: string;
    readonly chainId: number;
    readonly privateKey?: string;
  };
  readonly database: { readonly path: string };
  readonly risk: {
    readonly maxPositionSizeUsd: number;
    readonly maxTotalDeployedUsd: number;
    readonly maxDailyLossUsd: number;
    readonly maxOrdersPerMinute: number;
    readonly perMarketCooldownMs: number;
    readonly maxOpenOrdersPerMarket: number;
  };
  readonly simulator: {
    readonly latencyMs: number;
    readonly startingCashUsd: number;
  };
  readonly strategy: {
    readonly name: string;
    readonly markets: readonly string[];
    readonly params: Readonly<Record<string, unknown>>;
  };
  readonly recordSnapshots: boolean;
  readonly logLevel: 'trace' | 'debug' | 'info' | 'warn' | 'error';
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = EnvSchema.parse(env);

  if (parsed.MODE === 'live' && !parsed.POLYMARKET_PRIVATE_KEY) {
    throw new Error(
      'POLYMARKET_PRIVATE_KEY is required when MODE=live. Refusing to start in live mode without a signing key.',
    );
  }

  if (parsed.STRATEGY_MARKETS.length === 0 && parsed.MODE !== 'backtest') {
    throw new Error('STRATEGY_MARKETS must list at least one condition ID for paper or live mode.');
  }

  const cfg: Config = {
    mode: parsed.MODE,
    polymarket: {
      clobHost: parsed.POLYMARKET_CLOB_HOST,
      wsHost: parsed.POLYMARKET_WS_HOST,
      chainId: parsed.POLYMARKET_CHAIN_ID,
      ...(parsed.POLYMARKET_PRIVATE_KEY ? { privateKey: parsed.POLYMARKET_PRIVATE_KEY } : {}),
    },
    database: { path: parsed.DATABASE_PATH },
    risk: {
      maxPositionSizeUsd: parsed.RISK_MAX_POSITION_USD,
      maxTotalDeployedUsd: parsed.RISK_MAX_TOTAL_DEPLOYED_USD,
      maxDailyLossUsd: parsed.RISK_MAX_DAILY_LOSS_USD,
      maxOrdersPerMinute: parsed.RISK_MAX_ORDERS_PER_MINUTE,
      perMarketCooldownMs: parsed.RISK_PER_MARKET_COOLDOWN_MS,
      maxOpenOrdersPerMarket: parsed.RISK_MAX_OPEN_ORDERS_PER_MARKET,
    },
    simulator: {
      latencyMs: parsed.SIMULATOR_LATENCY_MS,
      startingCashUsd: parsed.SIMULATOR_STARTING_CASH_USD,
    },
    strategy: {
      name: parsed.STRATEGY_NAME,
      markets: parsed.STRATEGY_MARKETS,
      params: parsed.STRATEGY_PARAMS,
    },
    recordSnapshots: parsed.RECORD_SNAPSHOTS,
    logLevel: parsed.LOG_LEVEL,
  };
  return cfg;
}
