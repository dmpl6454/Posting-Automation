/**
 * Moved to @postautomation/queue (2026-09-28) so the web process and the worker
 * share ONE implementation of the publish-gate rule. Re-exported here so the
 * existing worker import paths keep working.
 *
 * ⚠️ Imported by FILE, not from the package root: the root also builds every
 * BullMQ queue (Redis connections) at load time, which a pure helper must not do.
 */
export { pendingPublishGates, wasParkedForSchedule, flipParkedPostIfReady } from "@postautomation/queue/src/publish-gates";
