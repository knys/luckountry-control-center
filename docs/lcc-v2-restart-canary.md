# LCC v2 restart recovery evidence

Use this sequence to document a Supervisor restart while a durable Job is in `ACTIVE`. Record timestamps, state snapshots, and process facts without recording credentials.

1. Record the persistent Job ID, current Lease, PID, and Heartbeat from the durable v2 state while the Job is `ACTIVE`.
2. Perform the `ACTIVE` process termination and record evidence that the original PID is no longer alive. Do not delete or edit the durable state.
3. Restart the Supervisor and record its reconciliation of the missing process to `FAILED_RETRYABLE`, including clearance of the expired Lease, PID, and Heartbeat.
4. Confirm the Supervisor schedules a bounded retry: the retry count increases without exceeding the retry limit and the Job returns through `QUEUED` to `LEASED`.
5. Confirm the retry retains the same persistent Job ID while acquiring a new Lease and reporting a new PID and new Heartbeat for the resumed `ACTIVE` attempt.
6. Record the continued lifecycle from that persistent Job ID through verification and completion, or capture the terminal failure if the bounded retry budget is exhausted.

The evidence demonstrates that restart recovery continues the existing durable Job rather than creating a replacement Job or relying on the terminated process's in-memory state.
