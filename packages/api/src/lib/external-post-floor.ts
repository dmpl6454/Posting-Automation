/**
 * Re-export of the SINGLE external-post floor definition.
 *
 * The constant used to live here and was duplicated as a literal date in the
 * worker and the cron. It now lives in @postautomation/queue — the one package
 * both the API and the worker already depend on — so the four call sites cannot
 * drift. See that file for why the floor is configurable and what it costs to
 * lower it.
 *
 * ⚠️ These are FUNCTIONS, not constants: the floor is read at call time so a
 * container restart is enough to change it.
 */
export {
  externalPostFloor,
  externalPostFloorLabel,
  DEFAULT_EXTERNAL_POST_FLOOR_ISO,
} from "@postautomation/queue";
