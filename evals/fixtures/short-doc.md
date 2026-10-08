# Zephyr Cache

Zephyr Cache is an in-memory key-value store written for edge servers with very little RAM.
It keeps every entry in a single arena, so a full eviction pass never needs to walk a pointer graph.

## Eviction

When the arena is ninety percent full, Zephyr Cache starts evicting the least recently used entries first.
Entries marked pinned are never evicted, even when the arena is completely full.
A pinned entry stays in memory until its owner explicitly unpins it or the process restarts.

## Persistence

Zephyr Cache writes a snapshot to disk every five minutes by default.
The snapshot interval can be changed with the snapshot_seconds setting.
After a crash, the server loads the newest complete snapshot and ignores any partially written file.

## Replication

A primary node streams every write to up to three replicas over a single TCP connection.
Replicas serve read requests but reject writes with an error that names the current primary.
If the primary stops responding for ten seconds, the replica with the highest sequence number promotes itself.

## Limits

Keys may be at most 250 bytes long, and values may be at most one megabyte.
The default maximum number of simultaneous client connections is four thousand.
