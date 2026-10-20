# Stock Token price check: the short version

**Question.** If an AI agent used a Robinhood Stock Token's on-chain price without checking anything, how
often would that price be unsafe or badly wrong?

**What we did.** We replayed Robinhood Chain every 5 minutes for 35 Stock Tokens, over two separate 30-day
windows. We used the first window to set the rules. We froze the rules, and then ran the second window,
2026-09-15 to 2026-10-14.

**Result: STOP.** In the test window, the price was badly wrong (unsafe and more than 3% off) on 0.000% of
samples, against a 0.5% bar. It was unsafe for any reason other than a closed market on 0.017%, against a 2%
bar. Both were under the bar, so by the frozen rules the risk was too rare to justify a paid service. We
publish the tools for free instead.

**Why it is close.** The result turns on single weekends. The largest weekend gap in the test window was 2.5%
(INTC). The earlier window had a 5.0% gap (SNDK), and scored the same way it would have read GO. One month
cannot tell "safe" from "lucky".

**What we learned along the way.**
- Market calendars are easy to get wrong. Friday 4 to 8 PM ET and holiday evenings are open sessions.
- The "deepest" trading pool for 6 of 35 tokens made no trades at all. Pool prices can mislead.
- Many pools were created during the period studied. Picking today's pool for past dates breaks the test.
- Dividend adjustments appear on-chain only about 5 to 10 minutes before they take effect.
- Two working price feeds (SGOV, USAR) are missing from Chainlink's published list.
- Feeds sometimes go quiet during open trading and then jump. In the first window, CRWV moved 7.3% after a
  silent night. No simple age rule catches this without constant false alarms.

**What this is not.** It reports data conditions. It is not investment advice, and it does not help anyone
buy Stock Tokens. Some risks could not be tested at all, such as oracle pauses, which never happened in
either window.

**Check it yourself.** The exact code, the frozen rules and the data are in this repository, with fingerprints
so anyone can verify them.