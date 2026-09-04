# LCC v2 rollback evidence checklist

Use this checklist after a v2 rollback. Record timestamps and command output in the rollback evidence; do not record credentials.

- [ ] **Retained v1 artifacts:** Confirm the previous v1 systemd units and release referenced by the deployment backup still exist and are readable.
- [ ] **Retained v2 state:** Confirm `/var/lib/luckountry-control-center/v2` and `/opt/luckountry-control-center-v2/releases` remain present; record a state-file checksum without modifying the data.
- [ ] **Service health:** Confirm the restored v1 units are active and `http://127.0.0.1:3000/health` returns success.
- [ ] **Dashboard consistency:** Compare the dashboard queue, active job, and status values with the retained durable state and record any mismatch.
- [ ] **Main revision:** Record `git rev-parse origin/main` and confirm the revision reported by the restored service matches the intended main revision.
