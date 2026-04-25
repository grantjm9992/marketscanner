import { describe, it, expect } from 'vitest';
import { loadConfig } from '../../../src/config/config.js';

const baseEnv = {
  MODE: 'paper',
  POLYMARKET_CLOB_HOST: 'https://clob.polymarket.com',
  POLYMARKET_WS_HOST: 'wss://ws.example.com',
  RISK_MAX_POSITION_USD: '100',
  RISK_MAX_TOTAL_DEPLOYED_USD: '500',
  RISK_MAX_DAILY_LOSS_USD: '50',
  STRATEGY_NAME: 'wide-spread-market-maker',
  STRATEGY_MARKETS: 'cond1,cond2',
} as NodeJS.ProcessEnv;

describe('loadConfig', () => {
  it('parses a valid paper-mode env', () => {
    const cfg = loadConfig(baseEnv);
    expect(cfg.mode).toBe('paper');
    expect(cfg.strategy.markets).toEqual(['cond1', 'cond2']);
    expect(cfg.risk.maxPositionSizeUsd).toBe(100);
  });

  it('rejects live mode without a private key', () => {
    expect(() => loadConfig({ ...baseEnv, MODE: 'live' })).toThrow(/POLYMARKET_PRIVATE_KEY/);
  });

  it('accepts live mode with a private key', () => {
    const cfg = loadConfig({ ...baseEnv, MODE: 'live', POLYMARKET_PRIVATE_KEY: '0xabc' });
    expect(cfg.mode).toBe('live');
    expect(cfg.polymarket.privateKey).toBe('0xabc');
  });

  it('parses STRATEGY_PARAMS as JSON', () => {
    const cfg = loadConfig({ ...baseEnv, STRATEGY_PARAMS: '{"minSpread":0.05}' });
    expect(cfg.strategy.params).toEqual({ minSpread: 0.05 });
  });

  it('rejects invalid JSON in STRATEGY_PARAMS', () => {
    expect(() => loadConfig({ ...baseEnv, STRATEGY_PARAMS: '{not json' })).toThrow();
  });

  it('rejects negative risk limits', () => {
    expect(() => loadConfig({ ...baseEnv, RISK_MAX_POSITION_USD: '-1' })).toThrow();
  });

  it('allows empty markets in backtest mode', () => {
    const cfg = loadConfig({ ...baseEnv, MODE: 'backtest', STRATEGY_MARKETS: '' });
    expect(cfg.strategy.markets).toEqual([]);
  });

  it('rejects empty markets in paper mode', () => {
    expect(() => loadConfig({ ...baseEnv, STRATEGY_MARKETS: '' })).toThrow(/STRATEGY_MARKETS/);
  });
});
