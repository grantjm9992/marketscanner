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
import { WideSpreadMarketMaker } from './strategy/strategies/wide-spread-market-maker.js';
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
  if (!isBacktest && config.recordSnapshots) {
    const recorder = new SnapshotRecorder(stores.marketSnapshot, logger);
    recorder.attach(feed);
  }

  // For paper/backtest: bridge feed → simulated venue so it sees books.
  if (config.mode !== 'live') {
    const sim = venue as SimulatedVenue;
    feed.onBookUpdate((b) => sim.onBookUpdate(b));
  }

  // --- Strategy ---
  const strategy = buildStrategy(config.strategy.name, config.strategy.params);

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
  });

  // Graceful shutdown.
  const shutdown = async (signal: string): Promise<void> => {
    logger.warn({ signal }, 'main: shutting down');
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

async function loadMarkets(
  config: Config,
  logger: import('./logging/logger.js').Logger,
  clock: import('./engine/clock.js').Clock,
): Promise<ReadonlyMap<string, Market>> {
  const ids = new Set<string>(config.strategy.markets);

  if (config.marketDiscovery.enabled) {
    const discovered = await discoverMarkets({
      gammaHost: config.marketDiscovery.gammaHost,
      filters: {
        categories: config.marketDiscovery.categories,
        minVolume24hUsd: config.marketDiscovery.minVolume24hUsd,
        minDaysToResolution: config.marketDiscovery.minDaysToResolution,
        minSpread: config.marketDiscovery.minSpread,
        maxSpread: config.marketDiscovery.maxSpread,
        limit: config.marketDiscovery.limit,
      },
      clock,
      logger,
    });
    for (const m of discovered) ids.add(m.conditionId);
    logger.info(
      { discovered: discovered.length, total: ids.size },
      'main: market discovery merged with explicit STRATEGY_MARKETS',
    );
  }

  const out = new Map<string, Market>();
  if (ids.size === 0) return out;

  const client = new ClobClient(config.polymarket.clobHost, config.polymarket.chainId);
  for (const conditionId of ids) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const raw = (await client.getMarket(conditionId)) as RawMarket | { error?: string };
      // The clob-client doesn't always throw on 4xx — it can return
      // {error: "..."}. Fail loudly so the bot doesn't silently run with
      // a half-broken market that has no outcomes to subscribe to.
      if ('error' in raw && raw.error) {
        throw new Error(`CLOB rejected market ${conditionId}: ${String(raw.error)}`);
      }
      const tokens = (raw as RawMarket).tokens ?? [];
      if (tokens.length === 0) {
        throw new Error(
          `Market ${conditionId} returned no outcomes. Likely an invalid condition ID — verify with the Gamma API or enable MARKET_DISCOVERY_ENABLED=true.`,
        );
      }
      out.set(conditionId, normalizeMarket(conditionId, raw as RawMarket));
    } catch (err) {
      logger.error({ err, conditionId }, 'main: failed to fetch market metadata');
      throw err;
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

function normalizeMarket(conditionId: string, raw: RawMarket): Market {
  return {
    conditionId,
    question: raw.question ?? '',
    outcomes: (raw.tokens ?? []).map((t) => ({ tokenId: t.token_id, label: t.outcome })),
    tickSize: price(Number(raw.minimum_tick_size ?? 0.01)),
    minOrderSize: size(Number(raw.minimum_order_size ?? 5)),
    endDate: raw.end_date_iso ? new Date(raw.end_date_iso) : new Date('2099-01-01'),
    category: raw.category ?? 'other',
  };
}

function buildStrategy(name: string, _params: Readonly<Record<string, unknown>>): Strategy {
  switch (name) {
    case 'wide-spread-market-maker':
      return new WideSpreadMarketMaker();
    default:
      throw new Error(`Unknown strategy: ${name}`);
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
