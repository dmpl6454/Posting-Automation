/**
 * Moved to @postautomation/social (packages/social/src/utils/public-address.ts)
 * so the platform providers can use it too. Re-exported here so existing api
 * imports keep working. The deep path avoids loading every social provider.
 */
export {
  isPrivateAddress,
  checkHostIsPublic,
  type HostCheck,
} from "@postautomation/social/src/utils/public-address";
