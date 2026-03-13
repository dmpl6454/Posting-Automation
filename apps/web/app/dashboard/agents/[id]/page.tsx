import { redirect } from "next/navigation";

export default function AgentChatRedirect({ params }: { params: { id: string } }) {
  redirect(`/dashboard/content-agent/${params.id}`);
}
