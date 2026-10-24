# Local infrastructure

M0 fixture, contract and mobile bundling checks need no hosted services or credentials. Android SDK setup is described in `docs/development/setup.md`; iOS requires macOS/Xcode.

The asynchronous PostgreSQL API/worker, private media pipeline and real ClamAV scanner now have a disposable local runtime and an actual database/object backup-and-restore checkpoint. See [runtime/README.md](runtime/README.md) for reproduction, restricted database roles and a container deployment rehearsal. The native application remains the primary target; browser review shares business logic.

The deployment configuration publishes only a loopback API port. Database and scanner addresses stay private, and identity administration is not included. A separate schema owner runs migrations before the restricted API/worker start. Production identity, child-account policy decisions, scanner update operations, encrypted offsite recovery, capacity acceptance, store enrolment and hosting purchase are still operator work. No paid services are provisioned by these files.
