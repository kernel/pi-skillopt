---
name: reversible-migrations
description: Teaches an agent to author SQL schema migrations as reversible up/down pairs against a populated SQLite database, applied with the sqlite3 CLI. Every change ships as NNNN_name.up.sql plus NNNN_name.down.sql, where the down returns the database to its exact pre-up state including the rows, so any migration can be rolled back without losing data.
---

# reversible-migrations

You write schema migrations as plain SQL files applied with the `sqlite3` CLI.
There is no migration framework: a migration is two files,
`NNNN_name.up.sql` and `NNNN_name.down.sql`, applied in numeric order. The
database already holds rows, so correctness means the data survives both
directions.

The contract: applying the up then the down must leave the database exactly as
it was before the up — same schema and same rows. The down is the inverse of
the up, not a sketch of it. If you cannot write a down that restores the data,
the up is not finished.

Rules:

- Adding a constraint over existing rows is three ordered statements, never one.
  To add a `NOT NULL` column to a populated table: (1) `ADD COLUMN` it as
  nullable, (2) `UPDATE` to backfill every existing row with a real value, (3)
  enforce `NOT NULL`. The same add-then-backfill-then-enforce shape applies to
  any constraint you tighten over data that already exists.
- Destructive changes carry their data back. A down for a dropped column or
  dropped table must recreate the structure and restore the rows that were
  there, so capture or reconstruct those rows in the down rather than leaving
  empty scaffolding.
- Type changes use explicit value-preserving casts. Widen rather than narrow;
  never cast in a direction that truncates or drops values. The down round-trips
  the values back to the original type without loss.
- Rename a column with add-copy-drop, never a bare in-place rename. `ADD` the
  new column, `UPDATE` to copy the data across, then `DROP` the old one. The
  down reverses each step and restores the original column's data.
- Applied history is frozen. Once a migration file has been applied, never edit
  it. A correction is a new file with the next sequence number that migrates
  forward from the current state.
- Reach for `IF EXISTS` / `IF NOT EXISTS` only at a boundary the runner may
  legitimately re-apply. Do not scatter them through a migration to mask an
  ordering mistake; fix the order instead.

## Gotchas
- An empty or no-op down is a bug. If the up changes the schema, the down has
  real statements that undo it. A down file that is blank, just a comment, or a
  `SELECT` does not roll anything back.
- Do not add a tightened constraint (such as `NOT NULL`) in a single statement
  over a populated table. The `ADD COLUMN ... NOT NULL` fails on the existing
  rows, the migration errors partway, and the database is left half-migrated.
  Split it into nullable add, backfill, then enforce.
- Do not rename a column in place, and never write a down that simply drops the
  renamed column. Both lose the original data silently. Use add-copy-drop and
  reverse it in the down.
- Do not cast to a narrower type or one that cannot represent every existing
  value. A down that converts back to the original type but truncates values
  (for example `TEXT` -> `INTEGER` when some values are non-numeric) is a
  data-loss bug. Each direction must preserve the full set of values.
- Do not edit an already-applied migration file to fix a mistake. The change
  never reaches a database that already ran the old version; put the correction
  in a new sequential file.
- A down that restores the structure but not the rows is incomplete. For a
  dropped column, the down must restore that column and its data, not just the
  column definition. For a dropped table, the down must recreate the table and
  `INSERT` the rows that were there — an empty `CREATE TABLE` is not a rollback.
