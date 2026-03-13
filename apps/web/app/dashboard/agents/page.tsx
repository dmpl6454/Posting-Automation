import { redirect } from "next/navigation";

export default function AgentsRedirect() {
  redirect("/dashboard/content-agent?tab=chat");
}
