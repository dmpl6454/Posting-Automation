import { redirect } from "next/navigation";

export default function ImageStudioRedirect() {
  redirect("/dashboard/content-agent?tab=image");
}
