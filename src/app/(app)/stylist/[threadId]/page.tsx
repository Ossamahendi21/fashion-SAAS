import { StylistChatRoute } from "@/components/stylist/stylist-chat-route";
import { requireSignedIn } from "@/lib/auth";

export default async function StylistThreadPage({ params, searchParams }: PageProps<"/stylist/[threadId]">) {
  await requireSignedIn();
  const { threadId } = await params;
  const { brief } = await searchParams;
  const initialBrief = typeof brief === "string" && brief.trim().length > 0 ? brief : undefined;

  return <StylistChatRoute threadId={threadId} initialBrief={initialBrief} />;
}
