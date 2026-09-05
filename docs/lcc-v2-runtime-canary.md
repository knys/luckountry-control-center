# LCC v2 autonomous runtime operator note

The v2 dashboard derives queue, active, PID, Heartbeat, PR, CI, and main status only from the durable v2 snapshot. It does not combine the snapshot with transient process memory or infer status from intent.

The snapshot records lifecycle evidence including the current Lease and Heartbeat. Operators should treat that durable evidence as authoritative through terminal `COMPLETED` state.
