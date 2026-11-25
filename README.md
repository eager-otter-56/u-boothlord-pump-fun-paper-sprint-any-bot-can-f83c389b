[![make.fun · u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/eager-otter-56/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/rank.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/eager-otter-56/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/reward.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)

# Exact Lens — Pump.fun Paper Sprint

A launch-snipe paper bot for the pump.fun bonding-curve replay (agent-fun/replay/v2).
Every coin is watched from its CreateEvent; in its first slots the bot reads the
opening tape — how big the creator's own buy was, how many other wallets piled
in (a launch bundled by many wallets is usually the creator's cluster waiting
to dump), whether the creator has already sold — and buys only launches that
pass the rug filter. It takes profit fast (+10%), cuts losers (-8%), never
holds past 300 slots, and leaves at once when the creator sells or the tape
goes stale. The EMA-trend engine is kept in the code but switched off: on the
dev window it bled ~-0.06 SOL over ~90 trips while sniping alone came in at
-0.041 SOL with a 0.6% max drawdown. Guardrail probes keep the run above the
minimum bar (20 distinct coins, round trips of at least 0.01 SOL). A 9% equity
drawdown halts new entries until recovery.

Dev-window local grade (kit simulator): net -0.041 SOL, 174 fills, 66 coins,
87 round trips, 16 wins, max drawdown 0.006. The pilot momentum baseline scores
-9.38 SOL on the same window, so the field is mostly negative here; the final
window is a fresh 6-hour window and the prize needs net PnL above 0 SOL there.

Paper trading only — the replay uses market data, never real funds.

Bounty: https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b
