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

  DATABASE_KIND: z.enum(['sqlite', 'postgres']).default('sqlite'),
  DATABASE_PATH: z.string().default('./data/bot.db'),
  DATABASE_URL: z.string().optional(),
  DATABASE_SSL: BoolStr.default('true'),

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

  // --- Market discovery (Gamma API) ---
  MARKET_DISCOVERY_ENABLED: BoolStr.default('false'),
  MARKET_DISCOVERY_GAMMA_HOST: z.string().url().default('https://gamma-api.polymarket.com'),
  MARKET_DISCOVERY_CATEGORIES: MarketsStr.default(''), // comma-separated; '' = any
  MARKET_DISCOVERY_MIN_VOLUME_USD: NumStr.default('5000').pipe(z.number().nonnegative()),
  MARKET_DISCOVERY_MIN_DAYS_TO_RESOLUTION: NumStr.default('7').pipe(z.number().nonnegative()),
  MARKET_DISCOVERY_MIN_SPREAD: NumStr.default('0.01').pipe(z.number().nonnegative()),
  MARKET_DISCOVERY_MAX_SPREAD: NumStr.default('0.10').pipe(z.number().nonnegative()),
  MARKET_DISCOVERY_LIMIT: IntStr.default('5').pipe(z.number().int().positive()),
  MARKET_DISCOVERY_REQUIRE_REWARDS: BoolStr.default('false'),
  /**
   * Optional case-insensitive regex applied to market questions.
   * Empty string = no filter. Useful to scope discovery to a topic
   * the strategy understands (e.g. `temperature|weather|rain|snow`
   * for the weather-forecast strategy).
   */
  MARKET_DISCOVERY_QUESTION_REGEX: z.string().default(''),

  // --- SmartMoneyFollower ---
  SMART_MONEY_DATA_API_HOST: z.string().url().default('https://data-api.polymarket.com'),
  /** Comma-separated wallet addresses to track. Empty = strategy disabled. */
  SMART_MONEY_WALLETS: MarketsStr.default(''),
  SMART_MONEY_POLL_MS: IntStr.default('5000').pipe(z.number().int().positive()),
  SMART_MONEY_COPY_USD: NumStr.default('10').pipe(z.number().positive()),
  SMART_MONEY_MIN_SOURCE_USD: NumStr.default('200').pipe(z.number().positive()),
  SMART_MONEY_MAX_AGE_MS: IntStr.default('30000').pipe(z.number().int().positive()),
  SMART_MONEY_MAX_DRIFT_CENTS: NumStr.default('0.03').pipe(z.number().nonnegative()),
  SMART_MONEY_EXECUTION_MODE: z.enum(['taker_market', 'taker_limit_at_touch']).default('taker_limit_at_touch'),
  SMART_MONEY_PER_MARKET_COOLDOWN_MS: IntStr.default('300000').pipe(z.number().int().nonnegative()),

  // --- Weather forecast strategy ---
  WEATHER_OPEN_METEO_HOST: z.string().url().default('https://api.open-meteo.com/v1/forecast'),
  WEATHER_MIN_EDGE: NumStr.default('0.05').pipe(z.number().nonnegative()),
  WEATHER_ORDER_USD: NumStr.default('20').pipe(z.number().positive()),
  WEATHER_MAX_ORDER_SIZE: IntStr.default('200').pipe(z.number().int().positive()),
  WEATHER_MAX_YES_PRICE: NumStr.default('0.97').pipe(z.number().min(0).max(1)),
  WEATHER_MIN_YES_PRICE: NumStr.default('0.03').pipe(z.number().min(0).max(1)),
  WEATHER_PER_MARKET_COOLDOWN_MS: IntStr.default('600000').pipe(z.number().int().nonnegative()),
  WEATHER_TRADE_DIRECTION: z.enum(['both', 'buy_only', 'sell_only']).default('both'),
});

export interface Config {
  readonly mode: 'live' | 'paper' | 'backtest';
  readonly polymarket: {
    readonly clobHost: string;
    readonly wsHost: string;
    readonly chainId: number;
    readonly privateKey?: string;
  };
  readonly database: {
    readonly kind: 'sqlite' | 'postgres';
    readonly path: string;
    readonly url?: string;
    readonly ssl: boolean;
  };
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
  readonly marketDiscovery: {
    readonly enabled: boolean;
    readonly gammaHost: string;
    readonly categories: readonly string[];
    readonly minVolume24hUsd: number;
    readonly minDaysToResolution: number;
    readonly minSpread: number;
    readonly maxSpread: number;
    readonly limit: number;
    readonly requireRewards: boolean;
    readonly questionRegex?: RegExp;
  };
  readonly smartMoney: {
    readonly dataApiHost: string;
    readonly wallets: readonly string[];
    readonly pollMs: number;
    readonly copyUsd: number;
    readonly minSourceUsd: number;
    readonly maxAgeMs: number;
    readonly maxDriftCents: number;
    readonly executionMode: 'taker_market' | 'taker_limit_at_touch';
    readonly perMarketCooldownMs: number;
  };
  readonly weather: {
    readonly openMeteoHost: string;
    readonly minEdge: number;
    readonly orderUsd: number;
    readonly maxOrderSize: number;
    readonly maxYesPrice: number;
    readonly minYesPrice: number;
    readonly perMarketCooldownMs: number;
    readonly tradeDirection: 'both' | 'buy_only' | 'sell_only';
  };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = EnvSchema.parse(env);

  if (parsed.DATABASE_KIND === 'postgres' && !parsed.DATABASE_URL) {
    throw new Error(
      'DATABASE_URL is required when DATABASE_KIND=postgres (e.g. postgres://user:pass@host:5432/db).',
    );
  }

  if (parsed.MODE === 'live' && !parsed.POLYMARKET_PRIVATE_KEY) {
    throw new Error(
      'POLYMARKET_PRIVATE_KEY is required when MODE=live. Refusing to start in live mode without a signing key.',
    );
  }

  if (
    parsed.STRATEGY_MARKETS.length === 0 &&
    parsed.MODE !== 'backtest' &&
    !parsed.MARKET_DISCOVERY_ENABLED
  ) {
    throw new Error(
      'STRATEGY_MARKETS must list at least one condition ID, or enable MARKET_DISCOVERY_ENABLED=true.',
    );
  }

  const cfg: Config = {
    mode: parsed.MODE,
    polymarket: {
      clobHost: parsed.POLYMARKET_CLOB_HOST,
      wsHost: parsed.POLYMARKET_WS_HOST,
      chainId: parsed.POLYMARKET_CHAIN_ID,
      ...(parsed.POLYMARKET_PRIVATE_KEY ? { privateKey: parsed.POLYMARKET_PRIVATE_KEY } : {}),
    },
    database: {
      kind: parsed.DATABASE_KIND,
      path: parsed.DATABASE_PATH,
      ...(parsed.DATABASE_URL ? { url: parsed.DATABASE_URL } : {}),
      ssl: parsed.DATABASE_SSL,
    },
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
    marketDiscovery: {
      enabled: parsed.MARKET_DISCOVERY_ENABLED,
      gammaHost: parsed.MARKET_DISCOVERY_GAMMA_HOST,
      categories: parsed.MARKET_DISCOVERY_CATEGORIES,
      minVolume24hUsd: parsed.MARKET_DISCOVERY_MIN_VOLUME_USD,
      minDaysToResolution: parsed.MARKET_DISCOVERY_MIN_DAYS_TO_RESOLUTION,
      minSpread: parsed.MARKET_DISCOVERY_MIN_SPREAD,
      maxSpread: parsed.MARKET_DISCOVERY_MAX_SPREAD,
      limit: parsed.MARKET_DISCOVERY_LIMIT,
      requireRewards: parsed.MARKET_DISCOVERY_REQUIRE_REWARDS,
      ...(parsed.MARKET_DISCOVERY_QUESTION_REGEX
        ? { questionRegex: new RegExp(parsed.MARKET_DISCOVERY_QUESTION_REGEX, 'i') }
        : {}),
    },
    smartMoney: {
      dataApiHost: parsed.SMART_MONEY_DATA_API_HOST,
      wallets: parsed.SMART_MONEY_WALLETS,
      pollMs: parsed.SMART_MONEY_POLL_MS,
      copyUsd: parsed.SMART_MONEY_COPY_USD,
      minSourceUsd: parsed.SMART_MONEY_MIN_SOURCE_USD,
      maxAgeMs: parsed.SMART_MONEY_MAX_AGE_MS,
      maxDriftCents: parsed.SMART_MONEY_MAX_DRIFT_CENTS,
      executionMode: parsed.SMART_MONEY_EXECUTION_MODE,
      perMarketCooldownMs: parsed.SMART_MONEY_PER_MARKET_COOLDOWN_MS,
    },
    weather: {
      openMeteoHost: parsed.WEATHER_OPEN_METEO_HOST,
      minEdge: parsed.WEATHER_MIN_EDGE,
      orderUsd: parsed.WEATHER_ORDER_USD,
      maxOrderSize: parsed.WEATHER_MAX_ORDER_SIZE,
      maxYesPrice: parsed.WEATHER_MAX_YES_PRICE,
      minYesPrice: parsed.WEATHER_MIN_YES_PRICE,
      perMarketCooldownMs: parsed.WEATHER_PER_MARKET_COOLDOWN_MS,
      tradeDirection: parsed.WEATHER_TRADE_DIRECTION,
    },
  };
  return cfg;
}
