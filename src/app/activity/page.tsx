import { ActivityPage } from "@/components/Activity";
export default async function Page({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const id = params.render || params.batch;
  return <ActivityPage key={typeof id === "string" ? id : "list"} initialSelection={typeof id === "string" ? { id, kind: params.render ? "render" : "batch" } : null} />;
}
