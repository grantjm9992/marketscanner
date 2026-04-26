import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline/promises';
import process from 'node:process';
import { Wallet } from 'ethers';
import { ClobClient } from '@polymarket/clob-client';
import { loadConfig } from './config/config.js';
import type { Config } from './config/config.js';
import { createLogger } from './logging/logger.js';
import { openStores } from './persistence/stores.js';
import { Engine, VenuePortfolioProvider } from './engine/engine.js';
import { FakeClock, SystemClock } from './engine/clock.js';
import {
  SimulatedVenue,
  type MarketSpec,
} from './execution/simulated-venue.js';
import { PolymarketFeeSchedule } from './execution/fees.js';
import { PolymarketVenue } from './execution/polymarket-venue.js';
import { PolymarketFeed } from './marketdata/polymarket-feed.js';
import { HistoricalFeed } from './marketdata/historical-feed.js';
import { SnapshotRecorder } from './marketdata/snapshot-recorder.js';
import { discoverMarkets } from './marketdata/market-discovery.js';
import { DefaultRiskManager } from './risk/risk-manager.js';
import {
  WideSpreadMarketMaker,
  DEFAULT_PARAMS as WSMM_DEFAULTS,
  type WideSpreadParams,
} from './strategy/strategies/wide-spread-market-maker.js';
import { SmartMoneyFollower } from './strategy/strategies/smart-money-follower.js';
import {
  RewardedMarketMaker,
  DEFAULT_REWARDED_PARAMS as RMM_DEFAULTS,
  type RewardedMarketMakerParams,
} from './strategy/strategies/rewarded-market-maker.js';
import { WeatherForecastStrategy } from './strategy/strategies/weather-forecast.js';
import { OpenMeteoForecastSource } from './forecasts/weather/open-meteo.js';
import { GeocodeCache } from './forecasts/weather/geocode.js';
import { PolymarketWalletTradeFeed } from './marketdata/polymarket-wallet-trade-feed.js';
import { MarketRefresher } from './marketdata/market-refresher.js';
import type { Strategy } from './strategy/strategy.js';
import type { Market } from './domain/market.js';
import { price, size, usd } from './domain/money.js';

interface CliArgs {
  mode: 'live' | 'paper' | 'backtest' | undefined;
  strategy: string | undefined;
  from: string | undefined;
  to: string | undefined;
}

async function main(): Promise<void> {
  // Load .env into process.env if present. Built-in since Node 20.12 / 21.7.
  try {
    process.loadEnvFile('.env');
  } catch {
    // No .env — fine, vars may come from the shell or systemd unit.
  }

  const args = parseCliArgs();
  const env = { ...process.env };
  if (args.mode) env.MODE = args.mode;
  if (args.strategy) env.STRATEGY_NAME = args.strategy;
  const config = loadConfig(env);

  const logger = createLogger({ level: config.logLevel, pretty: process.stdout.isTTY ?? false });
  logger.info({ mode: config.mode, strategy: config.strategy.name }, 'main: starting');

  if (config.mode === 'live') {
    await confirmLiveMode(config);
  }

  const stores = await openStores({
    kind: config.database.kind,
    mode: config.mode,
    sqlitePath: config.database.path,
    ...(config.database.url ? { pgConnectionString: config.database.url } : {}),
    pgSsl: config.database.ssl,
  });
  logger.info({ kind: config.database.kind }, 'main: stores opened');

  const isBacktest = config.mode === 'backtest';
  const clock = isBacktest
    ? new FakeClock(args.from ? new Date(args.from) : new Date('2026-01-01T00:00:00Z'))
    : new SystemClock();

  // --- Resolve market metadata ---
  const markets = await loadMarkets(config, logger, clock);
  if (markets.size === 0 && !isBacktest) {
    throw new Error(
      'No markets to trade. Either set STRATEGY_MARKETS to one or more valid condition IDs, ' +
        'or enable MARKET_DISCOVERY_ENABLED=true and loosen the discovery filters ' +
        '(MARKET_DISCOVERY_CATEGORIES is a comma-separated list of category names like ' +
        '"Sports,Politics" — leave empty for any category).',
    );
  }
  const marketSpecs = new Map<string, MarketSpec>(
    [...markets.values()].map((m) => [
      m.conditionId,
      { marketId: m.conditionId, tickSize: m.tickSize, minOrderSize: m.minOrderSize },
    ]),
  );

  // --- Risk manager ---
  const risk = new DefaultRiskManager({
    limits: {
      maxPositionSizeUsd: usd(config.risk.maxPositionSizeUsd),
      maxTotalDeployedUsd: usd(config.risk.maxTotalDeployedUsd),
      maxDailyLossUsd: usd(config.risk.maxDailyLossUsd),
      maxOrdersPerMinute: config.risk.maxOrdersPerMinute,
      perMarketCooldownMs: config.risk.perMarketCooldownMs,
      maxOpenOrdersPerMarket: config.risk.maxOpenOrdersPerMarket,
    },
    clock,
    logger,
  });

  // --- Venue ---
  const fees = new PolymarketFeeSchedule();
  let venue: import('./execution/venue.js').ExecutionVenue;
  let portfolioProvider: VenuePortfolioProvider;

  if (config.mode === 'live') {
    if (!config.polymarket.privateKey) throw new Error('live mode requires privateKey');
    const liveVenue = new PolymarketVenue({
      clobHost: config.polymarket.clobHost,
      chainId: config.polymarket.chainId,
      privateKey: config.polymarket.privateKey,
      clock,
      logger,
    });
    liveVenue.start();
    venue = liveVenue;
    // Live cash/positions tracking is on-chain; for now, use a thin stub.
    portfolioProvider = new VenuePortfolioProvider({
      snapshot: () => ({ cashUsd: usd(0), positions: [] }),
    });
  } else {
    const simVenue = new SimulatedVenue({
      clock,
      fees,
      latencyMs: config.simulator.latencyMs,
      startingCashUsd: usd(config.simulator.startingCashUsd),
      markets: marketSpecs,
      logger,
      tradeLog: stores.tradeLog,
    });
    venue = simVenue;
    portfolioProvider = new VenuePortfolioProvider(simVenue);
  }

  // --- Feed ---
  let feed: import('./marketdata/feed.js').MarketDataFeed;
  if (isBacktest) {
    if (!args.from || !args.to) {
      throw new Error('backtest mode requires --from and --to (ISO 8601 dates)');
    }
    feed = new HistoricalFeed({
      store: stores.marketSnapshot,
      clock: clock as FakeClock,
      from: new Date(args.from),
      to: new Date(args.to),
      logger,
    });
  } else {
    const tokensByMarket = new Map<string, readonly string[]>();
    for (const m of markets.values()) {
      tokensByMarket.set(
        m.conditionId,
        m.outcomes.map((o) => o.tokenId),
      );
    }
    feed = new PolymarketFeed({
      wsHost: config.polymarket.wsHost,
      tokensByMarket,
      logger,
    });
  }

  // --- Snapshot recorder (paper / live only) ---
  let recorder: SnapshotRecorder | undefined;
  if (!isBacktest && config.recordSnapshots) {
    recorder = new SnapshotRecorder(stores.marketSnapshot, logger);
    recorder.attach(feed);
  }

  // For paper/backtest: bridge feed → simulated venue so it sees books.
  if (config.mode !== 'live') {
    const sim = venue as SimulatedVenue;
    feed.onBookUpdate((b) => sim.onBookUpdate(b));
  }

  // --- Strategy ---
  const strategy = buildStrategy(config, logger);

  // --- Wallet feed (optional, only when strategy uses it AND wallets are configured) ---
  let walletFeed: import('./marketdata/wallet-trade-feed.js').WalletTradeFeed | undefined;
  if (
    typeof strategy.onWalletTrade === 'function' &&
    config.smartMoney.wallets.length > 0 &&
    !isBacktest
  ) {
    walletFeed = new PolymarketWalletTradeFeed({
      dataApiHost: config.smartMoney.dataApiHost,
      wallets: config.smartMoney.wallets,
      pollIntervalMs: config.smartMoney.pollMs,
      logger,
    });
    logger.info(
      { count: config.smartMoney.wallets.length, pollMs: config.smartMoney.pollMs },
      'main: wallet trade feed configured',
    );
  } else if (typeof strategy.onWalletTrade === 'function') {
    logger.warn(
      'main: strategy supports wallet trades but SMART_MONEY_WALLETS is empty (or backtest mode); strategy will produce no signals',
    );
  }

  // --- Engine ---
  const engine = new Engine({
    feed,
    venue,
    strategy,
    risk,
    portfolioProvider,
    logger,
    clock,
    markets,
    ...(walletFeed ? { walletFeed } : {}),
  });

  // --- Market refresher (optional, paper/live only) ---
  let refresher: MarketRefresher | undefined;
  if (
    config.marketDiscovery.enabled &&
    config.marketDiscovery.refreshMs > 0 &&
    !isBacktest
  ) {
    const client = new ClobClient(config.polymarket.clobHost, config.polymarket.chainId);
    refresher = new MarketRefresher({
      engine,
      logger,
      clock,
      gammaHost: config.marketDiscovery.gammaHost,
      filters: buildDiscoveryFilters(config),
      resolveMarket: makeMarketResolver(client, logger),
      intervalMs: config.marketDiscovery.refreshMs,
    });
  }

  // Graceful shutdown.
  const shutdown = async (signal: string): Promise<void> => {
    logger.warn({ signal }, 'main: shutting down');
    refresher?.stop();
    recorder?.detach();
    try {
      await engine.stop();
    } catch (err) {
      logger.error({ err }, 'main: engine.stop threw');
    }
    if (config.mode === 'live') {
      try {
        (venue as PolymarketVenue).stop();
      } catch {
        // ignore
      }
    }
    try {
      await stores.close();
    } catch {
      // ignore
    }
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  await engine.start();
  refresher?.start();
  if (isBacktest) {
    // HistoricalFeed runs synchronously inside start(); stop cleanly.
    await shutdown('backtest-complete');
  }
}

function parseCliArgs(): CliArgs {
  // pnpm v10 passes a literal `--` separator into argv when invoked as
  // `pnpm dev -- --mode paper`. Strip it so node's parseArgs doesn't
  // treat the rest as positionals.
  const raw = process.argv.slice(2).filter((a) => a !== '--');
  const { values } = parseArgs({
    args: raw,
    options: {
      mode: { type: 'string' },
      strategy: { type: 'string' },
      from: { type: 'string' },
      to: { type: 'string' },
    },
    allowPositionals: false,
    strict: false,
  });
  const m = values.mode as string | undefined;
  if (m && m !== 'live' && m !== 'paper' && m !== 'backtest') {
    throw new Error(`Invalid --mode: ${m}`);
  }
  return {
    mode: m as CliArgs['mode'],
    strategy: values.strategy as string | undefined,
    from: values.from as string | undefined,
    to: values.to as string | undefined,
  };
}

async function confirmLiveMode(config: Config): Promise<void> {
  const wallet = new Wallet(config.polymarket.privateKey ?? '');
  const lines = [
    '*** LIVE MODE — REAL USDC AT RISK ***',
    `  wallet:           ${wallet.address}`,
    `  max position USD: ${config.risk.maxPositionSizeUsd}`,
    `  max total USD:    ${config.risk.maxTotalDeployedUsd}`,
    `  max daily loss:   ${config.risk.maxDailyLossUsd}`,
  ];
  for (const l of lines) {
    // eslint-disable-next-line no-console
    console.warn(l);
  }

  // Headless escape hatch: on Railway / systemd / containers there is
  // no interactive stdin. Allow setting LIVE_CONFIRM='I UNDERSTAND' to
  // satisfy the same "you read the warning" gate without a TTY. Print
  // both the warning and the env var name so it's still impossible to
  // flip on by accident.
  if (process.env.LIVE_CONFIRM === 'I UNDERSTAND') {
    // eslint-disable-next-line no-console
    console.warn('  confirmed via LIVE_CONFIRM env var');
    return;
  }

  if (!process.stdin.isTTY) {
    throw new Error(
      'live-mode requires confirmation but stdin is not a TTY. Set LIVE_CONFIRM="I UNDERSTAND" in the environment to proceed headlessly.',
    );
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question('Type "I UNDERSTAND" exactly to proceed: ');
  rl.close();
  if (answer !== 'I UNDERSTAND') {
    throw new Error('live-mode confirmation not given; aborting');
  }
}

/** Build the discovery filters object from config (used at startup AND in MarketRefresher). */
function buildDiscoveryFilters(config: Config) {
  return {
    categories: config.marketDiscovery.categories,
    minVolume24hUsd: config.marketDiscovery.minVolume24hUsd,
    minDaysToResolution: config.marketDiscovery.minDaysToResolution,
    minSpread: config.marketDiscovery.minSpread,
    maxSpread: config.marketDiscovery.maxSpread,
    requireRewards: config.marketDiscovery.requireRewards,
    limit: config.marketDiscovery.limit,
    ...(config.marketDiscovery.questionRegex
      ? { questionRegex: config.marketDiscovery.questionRegex }
      : {}),
  };
}

/**
 * Resolve a single conditionId to a Market by hitting CLOB getMarket.
 * Used by both initial loadMarkets and the MarketRefresher.
 */
function makeMarketResolver(
  client: ClobClient,
  logger: import('./logging/logger.js').Logger,
): import('./marketdata/market-refresher.js').MarketResolver {
  return async (conditionId, rewards) => {
    try {
      const raw = (await client.getMarket(conditionId)) as RawMarket | { error?: string };
      if ('error' in raw && raw.error) {
        logger.error(
          { conditionId, error: raw.error },
          'main: CLOB rejected market',
        );
        return null;
      }
      const tokens = (raw as RawMarket).tokens ?? [];
      if (tokens.length === 0) {
        logger.warn({ conditionId }, 'main: CLOB market has no outcomes; skipping');
        return null;
      }
      return normalizeMarket(conditionId, raw as RawMarket, rewards);
    } catch (err) {
      logger.error({ err, conditionId }, 'main: getMarket failed');
      return null;
    }
  };
}

async function loadMarkets(
  config: Config,
  logger: import('./logging/logger.js').Logger,
  clock: import('./engine/clock.js').Clock,
): Promise<ReadonlyMap<string, Market>> {
  const ids = new Set<string>(config.strategy.markets);
  const rewardsByMarketId = new Map<string, import('./domain/market.js').MarketRewards>();

  if (config.marketDiscovery.enabled) {
    const discovered = await discoverMarkets({
      gammaHost: config.marketDiscovery.gammaHost,
      filters: buildDiscoveryFilters(config),
      clock,
      logger,
    });
    for (const m of discovered) {
      ids.add(m.conditionId);
      if (m.rewardsDailyRateUsd > 0 && m.rewardsMaxSpread !== null && m.rewardsMinSize !== null) {
        rewardsByMarketId.set(m.conditionId, {
          dailyRateUsd: m.rewardsDailyRateUsd,
          maxSpread: price(m.rewardsMaxSpread),
          minSize: size(m.rewardsMinSize),
        });
      }
    }
    logger.info(
      {
        discovered: discovered.length,
        withRewards: rewardsByMarketId.size,
        total: ids.size,
      },
      'main: market discovery merged with explicit STRATEGY_MARKETS',
    );
  }

  const out = new Map<string, Market>();
  if (ids.size === 0) return out;

  const client = new ClobClient(config.polymarket.clobHost, config.polymarket.chainId);
  const resolve = makeMarketResolver(client, logger);
  for (const conditionId of ids) {
    // eslint-disable-next-line no-await-in-loop
    const market = await resolve(conditionId, rewardsByMarketId.get(conditionId));
    if (market) out.set(conditionId, market);
    else if (!config.marketDiscovery.enabled) {
      // For hand-curated markets, the user expects all of them to be
      // valid — fail loudly. Discovered markets come and go, so we just
      // skip ones that fail at any point.
      throw new Error(
        `Market ${conditionId} could not be resolved. Verify the condition ID is correct.`,
      );
    }
  }
  return out;
}

interface RawMarket {
  question?: string;
  category?: string;
  end_date_iso?: string;
  minimum_order_size?: string | number;
  minimum_tick_size?: string | number;
  tokens?: ReadonlyArray<{ token_id: string; outcome: string }>;
}

function normalizeMarket(
  conditionId: string,
  raw: RawMarket,
  rewards?: import('./domain/market.js').MarketRewards,
): Market {
  return {
    conditionId,
    question: raw.question ?? '',
    outcomes: (raw.tokens ?? []).map((t) => ({ tokenId: t.token_id, label: t.outcome })),
    tickSize: price(Number(raw.minimum_tick_size ?? 0.01)),
    minOrderSize: size(Number(raw.minimum_order_size ?? 5)),
    endDate: raw.end_date_iso ? new Date(raw.end_date_iso) : new Date('2099-01-01'),
    category: raw.category ?? 'other',
    ...(rewards ? { rewards } : {}),
  };
}

function buildStrategy(config: Config, logger: import('./logging/logger.js').Logger): Strategy {
  const overrides = config.strategy.params;
  switch (config.strategy.name) {
    case 'wide-spread-market-maker': {
      const params: WideSpreadParams = { ...WSMM_DEFAULTS, ...(overrides as Partial<WideSpreadParams>) };
      if (Object.keys(overrides).length > 0) {
        logger.info({ params }, 'main: wide-spread-market-maker params applied from STRATEGY_PARAMS');
      }
      return new WideSpreadMarketMaker(params);
    }
    case 'smart-money-follower':
      return new SmartMoneyFollower({
        copyNotionalUsd: config.smartMoney.copyUsd,
        minSourceNotionalUsd: config.smartMoney.minSourceUsd,
        maxAgeMs: config.smartMoney.maxAgeMs,
        maxPriceDriftCents: config.smartMoney.maxDriftCents,
        executionMode: config.smartMoney.executionMode,
        perMarketCooldownMs: config.smartMoney.perMarketCooldownMs,
      });
    case 'rewarded-market-maker': {
      const params: RewardedMarketMakerParams = { ...RMM_DEFAULTS, ...(overrides as Partial<RewardedMarketMakerParams>) };
      if (Object.keys(overrides).length > 0) {
        logger.info({ params }, 'main: rewarded-market-maker params applied from STRATEGY_PARAMS');
      }
      return new RewardedMarketMaker(params);
    }
    case 'weather-forecast': {
      const forecasts = new OpenMeteoForecastSource({
        host: config.weather.openMeteoHost,
        logger,
      });
      const geocodeCache = new GeocodeCache({ logger });
      return new WeatherForecastStrategy(
        forecasts,
        {
          minEdge: config.weather.minEdge,
          orderUsd: config.weather.orderUsd,
          maxOrderSize: config.weather.maxOrderSize,
          maxYesPrice: config.weather.maxYesPrice,
          minYesPrice: config.weather.minYesPrice,
          perMarketCooldownMs: config.weather.perMarketCooldownMs,
          tradeDirection: config.weather.tradeDirection,
        },
        geocodeCache,
      );
    }
    default:
      throw new Error(`Unknown strategy: ${config.strategy.name}`);
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
