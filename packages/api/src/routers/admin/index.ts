import { createRouter } from "../../trpc";
import { adminOverviewRouter } from "./overview.router";
import { adminUsersRouter } from "./users.router";
import { adminOrgsRouter } from "./orgs.router";
import { adminPostsRouter } from "./posts.router";
import { adminChannelsRouter } from "./channels.router";
import { adminAgentsRouter } from "./agents.router";
import { adminMediaRouter } from "./media.router";
import { adminQueuesRouter } from "./queues.router";
import { adminAuditRouter } from "./audit.router";
import { adminTeamsRouter } from "./teams.router";

export const adminRouter = createRouter({
  overview: adminOverviewRouter,
  users: adminUsersRouter,
  orgs: adminOrgsRouter,
  teams: adminTeamsRouter,
  posts: adminPostsRouter,
  channels: adminChannelsRouter,
  agents: adminAgentsRouter,
  media: adminMediaRouter,
  queues: adminQueuesRouter,
  audit: adminAuditRouter,
});
