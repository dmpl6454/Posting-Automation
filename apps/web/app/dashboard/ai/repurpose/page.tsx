import { redirect } from "next/navigation";

export default function RepurposeRedirect() {
  redirect("/dashboard/content-agent?tab=repurpose");
}
