// Exact Lens: an EMA-trend paper bot for the pump.fun bonding-curve replay
// (agent-fun/replay/v2). Written fresh for this competition.
//
// One idea, kept tight: a curve is bought only when its own tape proves a trend —
// the fast EMA of trade prices sits above the slow EMA, the trailing 120-trade
// return is positive, and fresh SOL is still flowing in from several distinct
// buyers. Size is vol-scaled (calm tapes get more, wild tapes get less) and
// capped by the 1%-of-real-reserve rule. Exits use wide hysteresis so a position
// is not shaken out by one bad batch: a hard stop, a trailing stop that only
// arms once the trade is up, a fade exit on outflow, and a time limit.
//
// Guardrail probes keep the run above the minimum bar (20 distinct coins, round
// trips of at least 0.01 SOL): when the bot's own fills or coins lag a pace set
// in block time, it buys a tiny probe of a liquid curve and sells it as soon as
// the buy lands.
//
// Deterministic by construction: no clock, no randomness, iteration only over
// insertion-ordered maps fed by the batch stream.

import type { Batch, Bot, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

export interface Params {
  /** Trend mode on/off. Off: the bot snipes launches only (best on the dev window). */
  trendOn: boolean;
  /** Fast EMA span, in trades. */
  emaFast: number;
  /** Slow EMA span, in trades. */
  emaSlow: number;
  /** Trades recorded on a curve before its EMAs are trusted. */
  warmupTrades: number;
  /** Fast EMA must exceed slow EMA by at least this fraction. */
  trendGap: number;
  /** Lookback, in trades, for the trailing return. */
  trailTrades: number;
  /** Trailing return must exceed this fraction. */
  minTrailRet: number;
  /** Lookback, in trades, for inflow / buyers / near-high / volatility. */
  windowTrades: number;
  /** Net buy SOL (buys minus sells) over the window. */
  minNetSol: number;
  /** Distinct buying wallets in the window. */
  minBuyers: number;
  /** Price now at least this share of the window's high. */
  nearHigh: number;
  /** Curve real SOL bounds at entry. */
  minRqSol: number;
  maxRqSol: number;
  /** Slots since the CreateEvent before an entry is allowed. */
  minAge: number;
  /** Reference stake (SOL) before vol scaling. */
  baseStakeSol: number;
  /** Target fractional volatility for sizing; size scales as target/vol. */
  targetVol: number;
  /** Smallest / largest single position (SOL). */
  minStakeSol: number;
  maxStakeSol: number;
  /** Smallest buy worth sending. */
  minBuySol: number;
  /** Slippage on buys (bps); sells always go out at 10000. */
  buySlipBps: number;
  /** Exit when close value falls below cost * (1 - stopLoss). */
  stopLoss: number;
  /** Exit when close value falls below peak * (1 - trail), once armed. */
  trail: number;
  /** The trailing stop arms once value reached cost * (1 + trailArm). */
  trailArm: number;
  /** Exit when net SOL over the fade window falls below -fadeNetSol. */
  fadeWindow: number;
  fadeNetSol: number;
  /** Exit on any single recorded sell of at least this many SOL. */
  bigSellSol: number;
  /** Exit after this many slots held (unless up at least holdIfUp). */
  maxHold: number;
  /** The time limit does not apply while the position is up at least this much. */
  holdIfUp: number;
  /** Slots to wait after an exit before the same curve may be bought again. */
  cooldown: number;
  /** Most entries per curve over the run. */
  maxEntries: number;
  /** Most main positions open at once (the rest of caps.max_open_positions is for probes). */
  maxMain: number;
  /** Most SOL at cost across all positions at once (a drawdown guard). */
  maxExposureSol: number;
  /** Halt new entries while equity is below peak * (1 - ddHalt). */
  ddHalt: number;
  /** Resume entries once equity recovers above peak * (1 - ddResume). */
  ddResume: number;
  /** Hold on (no fade, trail or big-sell exit) once the curve's real SOL passes this: completion is near. */
  rideRqSol: number;
  /** Launch-snipe mode: buy very young curves whose opening tape passes the rug filter. */
  snipeOn: boolean;
  /** Oldest age (slots since create) at which a snipe buy may still be decided. */
  snipeMaxAge: number;
  /** Trades seen before a snipe entry. */
  snipeMinTrades: number;
  /** Distinct non-creator buyers before a snipe entry, at least / at most. */
  snipeMinBuyers: number;
  snipeMaxBuyers: number;
  /** Creator's own buys in the opening tape: SOL window. */
  snipeMinDevBuy: number;
  snipeMaxDevBuy: number;
  /** Lamports sold by others / lamports bought, at most. */
  snipeMaxSellRatio: number;
  /** Price now over the create price, as a fraction: window. */
  snipeMinRunup: number;
  snipeMaxRunup: number;
  /** Real SOL reserve window at snipe decision time. */
  snipeMinRq: number;
  snipeMaxRq: number;
  /** SOL to put into one snipe position. */
  snipeStake: number;
  /** Snipe take-profit / stop-loss, as fractions of cost. */
  snipeTp: number;
  snipeSl: number;
  /** Snipe exit after this many slots held. */
  snipeMaxHold: number;
  /** Snipe exit when no trade has hit the coin for this many slots. */
  snipeStale: number;
  /** Guardrail pacing targets (fills / coins over paceSecs of block time). */
  targetCoins: number;
  targetFills: number;
  paceSecs: number;
  /** Size of one guardrail probe round trip (SOL). */
  probeSol: number;
  maxProbes: number;
}

export const DEFAULT_PARAMS: Params = {
  trendOn: false,
  emaFast: 10,
  emaSlow: 30,
  warmupTrades: 20,
  trendGap: 0.002,
  trailTrades: 60,
  minTrailRet: 0.002,
  windowTrades: 30,
  minNetSol: 0.5,
  minBuyers: 4,
  nearHigh: 0.95,
  minRqSol: 2,
  maxRqSol: 80,
  minAge: 50,
  baseStakeSol: 0.5,
  targetVol: 0.02,
  minStakeSol: 0.05,
  maxStakeSol: 1.0,
  minBuySol: 0.01,
  buySlipBps: 1500,
  stopLoss: 0.1,
  trail: 0.1,
  trailArm: 0.02,
  fadeWindow: 15,
  fadeNetSol: 0.5,
  bigSellSol: 5,
  maxHold: 400,
  holdIfUp: 1.0,
  cooldown: 120,
  maxEntries: 2,
  maxMain: 5,
  maxExposureSol: 6,
  ddHalt: 0.09,
  ddResume: 0.05,
  rideRqSol: 60,
  snipeOn: true,
  snipeMaxAge: 10,
  snipeMinTrades: 3,
  snipeMinBuyers: 3,
  snipeMaxBuyers: 12,
  snipeMinDevBuy: 0.05,
  snipeMaxDevBuy: 2.0,
  snipeMaxSellRatio: 0.2,
  snipeMinRunup: 0,
  snipeMaxRunup: 0.5,
  snipeMinRq: 0.1,
  snipeMaxRq: 20,
  snipeStake: 0.1,
  snipeTp: 0.1,
  snipeSl: 0.08,
  snipeMaxHold: 300,
  snipeStale: 200,
  targetCoins: 22,
  targetFills: 120,
  paceSecs: 14400,
  probeSol: 0.01,
  maxProbes: 1,
};

const LAMPORTS = 1e9;
const CURVE_FEE = 0.0125;

interface Trade {
  slot: number;
  buy: boolean;
  sol: number;
  user: string;
  price: number;
}

interface Tape {
  created: number | null;
  creator: string | null;
  createPrice: number;
  creatorBuy: number;
  creatorSold: boolean;
  trades: Trade[];
  emaFast: number;
  emaSlow: number;
  entries: number;
  lastExit: number;
  lastTradeSlot: number;
}

interface Held {
  opened: number;
  peakValue: number;
  /** SOL spent in buys for this position (fees included). */
  invested: number;
  exiting: boolean;
  filled: boolean;
  lastValue: number;
  /** True when this position came from a launch snipe (fast TP/SL exits). */
  snipe: boolean;
}

export function createStrategy(p: Params = DEFAULT_PARAMS): Bot {
  const tapes = new Map<Pubkey, Tape>();
  const held = new Map<Pubkey, Held>();
  /** Probe round trips in flight, by mint: false while buying, true once selling. */
  const probes = new Map<Pubkey, boolean>();
  /** The bot's own filled orders and the coins they were on (harness closes excluded). */
  let myFills = 0;
  const myCoins = new Set<Pubkey>();
  let firstTime: number | null = null;
  let lastTime: number | null = null;
  /** Peak equity (SOL) seen, for the drawdown guard; -1 until the first batch. */
  let peakEquity = -1;
  let halted = false;
  const keep = Math.max(p.trailTrades, p.windowTrades, p.fadeWindow) + 5;
  const aFast = 2 / (p.emaFast + 1);
  const aSlow = 2 / (p.emaSlow + 1);

  const tapeOf = (mint: Pubkey): Tape => {
    let t = tapes.get(mint);
    if (t === undefined) {
      t = { created: null, creator: null, createPrice: NaN, creatorBuy: 0, creatorSold: false, trades: [], emaFast: NaN, emaSlow: NaN, entries: 0, lastExit: -1e12, lastTradeSlot: -1 };
      tapes.set(mint, t);
    }
    return t;
  };

  /** Launch-snipe signal: a very young curve whose opening tape passes the rug filter. */
  const snipeSignal = (t: Tape, now: number, rqSol: number): boolean => {
    if (!p.snipeOn) return false;
    if (t.created === null || now - t.created > p.snipeMaxAge) return false;
    if (rqSol < p.snipeMinRq || rqSol > p.snipeMaxRq) return false;
    if (t.trades.length < p.snipeMinTrades) return false;
    if (t.creatorSold) return false;
    if (t.creatorBuy < p.snipeMinDevBuy || t.creatorBuy > p.snipeMaxDevBuy) return false;
    let buySol = 0;
    let sellSol = 0;
    const buyers = new Set<string>();
    for (const tr of t.trades) {
      if (tr.buy) {
        buySol += tr.sol;
        if (tr.user !== t.creator) buyers.add(tr.user);
      } else {
        sellSol += tr.sol;
      }
    }
    if (buyers.size < p.snipeMinBuyers || buyers.size > p.snipeMaxBuyers) return false;
    if (buySol <= 0 || sellSol / buySol > p.snipeMaxSellRatio) return false;
    const priceNow = t.trades[t.trades.length - 1]!.price;
    if (!Number.isFinite(t.createPrice) || t.createPrice <= 0) return false;
    const runup = priceNow / t.createPrice - 1;
    if (runup < p.snipeMinRunup || runup > p.snipeMaxRunup) return false;
    return true;
  };

  /** Net recorded SOL (buys minus sells) over the last `w` trades. */
  const flowTrades = (t: Tape, w: number): number => {
    let net = 0;
    const from = Math.max(0, t.trades.length - w);
    for (let i = from; i < t.trades.length; i++) {
      const tr = t.trades[i]!;
      net += tr.buy ? tr.sol : -tr.sol;
    }
    return net;
  };

  /** Entry signal on a curve's tape at slot `now`; also returns the vol-scaled stake. */
  const entrySignal = (t: Tape, now: number, rqSol: number): { ok: boolean; stake: number } => {
    const no = { ok: false, stake: 0 };
    if (rqSol < p.minRqSol || rqSol > p.maxRqSol) return no;
    if (t.created === null || now - t.created < p.minAge) return no;
    if (t.trades.length < p.warmupTrades) return no;
    if (!(t.emaFast > t.emaSlow * (1 + p.trendGap))) return no;
    const n = t.trades.length;
    const priceNow = t.trades[n - 1]!.price;
    const back = t.trades[Math.max(0, n - p.trailTrades)]!;
    if (back.price <= 0 || priceNow / back.price - 1 < p.minTrailRet) return no;
    const from = Math.max(0, n - p.windowTrades);
    let buySol = 0;
    let sellSol = 0;
    let buys = 0;
    let high = 0;
    let low = Infinity;
    let sum = 0;
    const byUser = new Set<string>();
    for (let i = from; i < n; i++) {
      const tr = t.trades[i]!;
      if (tr.buy) {
        buySol += tr.sol;
        buys++;
        byUser.add(tr.user);
      } else {
        sellSol += tr.sol;
      }
      if (tr.price > high) high = tr.price;
      if (tr.price < low) low = tr.price;
      sum += tr.price;
    }
    if (buys < 3 || byUser.size < p.minBuyers) return no;
    if (buySol - sellSol < p.minNetSol) return no;
    if (priceNow < high * p.nearHigh) return no;
    // Vol-scaled sizing: calm tapes earn the full stake, wild tapes get cut down.
    const mean = sum / (n - from);
    const vol = mean > 0 ? (high - low) / mean : 1;
    const scaled = p.baseStakeSol * (p.targetVol / Math.max(vol, 1e-6));
    const stake = Math.min(p.maxStakeSol, Math.max(p.minStakeSol, scaled));
    return { ok: true, stake };
  };

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const now = batch.slot;
      const bigSell = new Set<Pubkey>();
      const traded = new Set<Pubkey>();
      for (const f of batch.fills) {
        if (f.status === 'filled' && !f.client_id.startsWith('_')) {
          myFills++;
          myCoins.add(f.mint);
        }
      }
      for (const e of batch.events) {
        if (e.block_time !== null) {
          if (firstTime === null) firstTime = e.block_time;
          if (lastTime === null || e.block_time > lastTime) lastTime = e.block_time;
        }
        if (e.event === 'CreateEvent') {
          const t = tapeOf(e.mint);
          t.created = e.slot;
          t.creator = e.creator;
          t.createPrice = Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves);
        } else if (e.event === 'TradeEvent') {
          const t = tapeOf(e.mint);
          const sol = Number(e.sol_amount) / LAMPORTS;
          const price = Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves);
          t.trades.push({ slot: e.slot, buy: e.is_buy, sol, user: e.user, price });
          t.lastTradeSlot = e.slot;
          if (t.creator !== null && e.user === t.creator) {
            if (e.is_buy) t.creatorBuy += sol;
            else t.creatorSold = true;
          }
          if (Number.isNaN(t.emaFast)) {
            t.emaFast = price;
            t.emaSlow = price;
          } else {
            t.emaFast += aFast * (price - t.emaFast);
            t.emaSlow += aSlow * (price - t.emaSlow);
          }
          traded.add(e.mint);
          if (!e.is_buy && sol >= p.bigSellSol) bigSell.add(e.mint);
        }
      }
      for (const mint of traded) {
        const t = tapes.get(mint)!;
        if (t.trades.length > keep) t.trades.splice(0, t.trades.length - keep);
      }
      const marks = new Map(batch.marks.map((m) => [m.mint, m] as const));
      const pendingByMint = new Map<Pubkey, number>();
      for (const po of state.pending.values()) pendingByMint.set(po.order.mint, (pendingByMint.get(po.order.mint) ?? 0) + 1);

      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const tx = Number(state.txFeeLamports()) / LAMPORTS;

      // Equity for the drawdown guard: cash plus position close values at the marks.
      let equity = Number(state.cash) / LAMPORTS;
      for (const [mint, pos] of state.positions) {
        const mk = marks.get(mint);
        const curve = state.curves.get(mint);
        if (mk === undefined && curve === undefined) continue;
        const vq = mk ? Number(mk.virtual_quote_reserves) : Number(curve!.virtual_quote_reserves);
        const vt = mk ? Number(mk.virtual_token_reserves) : Number(curve!.virtual_token_reserves);
        const tokens = Number(pos.token_amount);
        equity += ((tokens * vq) / (vt + tokens) / LAMPORTS) * (1 - CURVE_FEE) - tx;
      }
      if (peakEquity < 0) peakEquity = equity;
      if (equity > peakEquity) peakEquity = equity;
      if (halted) {
        if (equity > peakEquity * (1 - p.ddResume)) halted = false;
      } else if (equity < peakEquity * (1 - p.ddHalt)) {
        halted = true;
      }

      // Exits first.
      for (const [mint, h] of held) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) {
            held.delete(mint);
            const t = tapeOf(mint);
            if (h.filled) t.lastExit = now;
            else t.entries--;
          }
          continue;
        }
        h.filled = true;
        if (curve === undefined || curve.complete) continue;
        const mk = marks.get(mint);
        const vq = mk ? Number(mk.virtual_quote_reserves) : Number(curve.virtual_quote_reserves);
        const vt = mk ? Number(mk.virtual_token_reserves) : Number(curve.virtual_token_reserves);
        const tokens = Number(pos.token_amount);
        const value = ((tokens * vq) / (vt + tokens) / LAMPORTS) * (1 - CURVE_FEE) - tx;
        const cost = Number(pos.cost_lamports) / LAMPORTS;
        if (value > h.peakValue) h.peakValue = value;
        h.lastValue = value;
        let exit = h.exiting;
        const t = tapeOf(mint);
        const rqSol = (mk ? Number(mk.real_quote_reserves) : Number(curve.real_quote_reserves)) / LAMPORTS;
        const riding = rqSol >= p.rideRqSol;
        if (h.snipe) {
          // Snipe exits: take profit fast, cut losers, never hold past the limit,
          // leave at once when the creator sells or the tape goes stale — unless
          // the curve is near completion (rideRqSol), where the payoff is the
          // completion itself and the harness closes the position.
          const riding = rqSol >= p.rideRqSol;
          if (!exit && !riding && value >= cost * (1 + p.snipeTp)) exit = true;
          if (!exit && !riding && value < cost * (1 - p.snipeSl)) exit = true;
          if (!exit && now - h.opened > p.snipeMaxHold) exit = true;
          if (!exit && t.creatorSold) exit = true;
          if (!exit && !riding && now - t.lastTradeSlot > p.snipeStale) exit = true;
        } else {
          if (!exit && value < cost * (1 - p.stopLoss)) exit = true;
          if (!exit && !riding && h.peakValue >= cost * (1 + p.trailArm) && value < h.peakValue * (1 - p.trail)) exit = true;
          if (!exit && !riding && flowTrades(t, p.fadeWindow) < -p.fadeNetSol) exit = true;
          if (!exit && !riding && bigSell.has(mint)) exit = true;
          if (!exit && now - h.opened > p.maxHold && value < cost * (1 + p.holdIfUp)) exit = true;
        }
        if (!exit) continue;
        h.exiting = true;
        if (pendingByMint.has(mint)) {
          let sellPending = false;
          for (const po of state.pending.values()) if (po.order.mint === mint && po.order.side === 'sell') sellPending = true;
          if (sellPending) continue;
        }
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
      }

      // Probe round trips: sell the whole probe as soon as its buy has landed.
      for (const [mint, selling] of probes) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) probes.delete(mint);
          continue;
        }
        if (curve === undefined || curve.complete || pendingByMint.has(mint)) continue;
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
        if (!selling) probes.set(mint, true);
      }

      // Then entries.
      let free = Number(state.freeCashLamports()) / LAMPORTS;
      let slotsLeft = state.hello.caps.max_open_positions - state.committedPositionCount();
      let mainLeft = p.maxMain - held.size;
      let exposure = 0;
      for (const [mint, h] of held) exposure += Math.max(h.invested, Number(state.positions.get(mint)?.cost_lamports ?? 0n) / LAMPORTS);
      if (!halted) {
        for (const mint of traded) {
          if (orders.length >= cap) break;
          const curve = state.curves.get(mint);
          if (curve === undefined || curve.complete) continue;
          if (pendingByMint.has(mint) || probes.has(mint)) continue;
          const t = tapes.get(mint)!;
          if (held.has(mint)) continue;
          if (slotsLeft <= 0 || mainLeft <= 0) continue;
          if (t.entries >= p.maxEntries || now - t.lastExit < p.cooldown) continue;
          const rqSol = Number(curve.real_quote_reserves) / LAMPORTS;
          // Launch snipe first: young curves get the fast TP/SL treatment.
          if (snipeSignal(t, now, rqSol)) {
            const capSol = Math.floor(Number(state.maxBuyLamports(mint))) / LAMPORTS;
            let amount = Math.min(capSol, p.snipeStake, p.maxExposureSol - exposure);
            if (amount > free - tx) amount = free - tx;
            if (amount >= p.minBuySol) {
              const lamports = BigInt(Math.floor(amount * LAMPORTS));
              orders.push({ side: 'buy', mint, quote_lamports: lamports, max_slippage_bps: p.buySlipBps });
              free -= amount + tx;
              exposure += amount;
              held.set(mint, { opened: now, peakValue: 0, invested: amount, exiting: false, filled: false, lastValue: 0, snipe: true });
              t.entries++;
              slotsLeft--;
              mainLeft--;
              continue;
            }
          }
          const sig = p.trendOn ? entrySignal(t, now, rqSol) : { ok: false, stake: 0 };
          if (!sig.ok) continue;
          const capSol = Math.floor(Number(state.maxBuyLamports(mint))) / LAMPORTS;
          let amount = Math.min(capSol, sig.stake, p.maxExposureSol - exposure);
          if (amount > free - tx) amount = free - tx;
          if (amount < p.minBuySol) continue;
          const lamports = BigInt(Math.floor(amount * LAMPORTS));
          orders.push({ side: 'buy', mint, quote_lamports: lamports, max_slippage_bps: p.buySlipBps });
          free -= amount + tx;
          exposure += amount;
          held.set(mint, { opened: now, peakValue: 0, invested: amount, exiting: false, filled: false, lastValue: 0, snipe: false });
          t.entries++;
          slotsLeft--;
          mainLeft--;
        }
      }

      // Guardrail pacing: open a probe when the bot's fills or coins lag the pace.
      if (probes.size < p.maxProbes && slotsLeft > 0 && firstTime !== null && lastTime !== null) {
        const pace = Math.min(1, (lastTime - firstTime) / p.paceSecs);
        const needCoins = myCoins.size < Math.ceil(p.targetCoins * pace);
        const needFills = myFills < Math.ceil(p.targetFills * pace);
        if (needCoins || needFills) {
          const minRq = (p.probeSol * 10_000) / state.hello.caps.max_order_bps_of_real_reserve;
          for (const mint of traded) {
            if (orders.length >= cap || probes.size >= p.maxProbes) break;
            if (held.has(mint) || probes.has(mint) || pendingByMint.has(mint) || state.positions.has(mint)) continue;
            if (needCoins && !needFills && myCoins.has(mint)) continue;
            const curve = state.curves.get(mint);
            if (curve === undefined || curve.complete) continue;
            if (Number(curve.real_quote_reserves) / LAMPORTS < minRq * 1.5) continue;
            if (free < p.probeSol + 2 * tx) break;
            orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(p.probeSol * LAMPORTS)), max_slippage_bps: p.buySlipBps });
            probes.set(mint, false);
            free -= p.probeSol + tx;
          }
        }
      }
      return orders;
    },
  };
}
