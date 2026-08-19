/**
 * Re-export of the SINGLE Insights-population definition.
 *
 * Lives in @postautomation/queue — the one package both the API and the worker
 * already depend on — so the read side (this container) and the ingestion side
 * (the worker) cannot drift. See that file for the owner decision, why the check
 * is fail-closed, and what turning it back on costs.
 *
 * ⚠️ A FUNCTION, not a constant: read at call time so a container restart is
 * enough to change it.
 */
export { insightsIncludeExternalPosts } from "@postautomation/queue";
