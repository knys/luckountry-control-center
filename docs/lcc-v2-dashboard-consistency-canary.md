# LCC v2 dashboard consistency contract

The dashboard is a projection of durable Job state and current execution evidence. It must apply these rules consistently:

- **Queue Depth:** Count only Jobs whose durable state is `QUEUED`.
- **ACTIVE:** Report a Job as `ACTIVE` only when its PID is live and both its Heartbeat and Lease are fresh.
- **Ball Holder:** Identify a Ball Holder only when the Job has a valid Lease and a next action.
- **GitHub completion:** Report GitHub completion only when Pull Request (PR), continuous integration (CI), and main-branch evidence all confirm completion.

If the required evidence for a dashboard value is absent or stale, the dashboard must not infer that value from intent or an earlier lifecycle state.
