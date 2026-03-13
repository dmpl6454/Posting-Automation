import { redirect } from "next/navigation";

export default function AIStudioRedirect() {
  redirect("/dashboard/content-agent?tab=generate");
}
