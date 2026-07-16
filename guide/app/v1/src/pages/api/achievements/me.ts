import type { APIRoute } from "astro";
import { readUserAchievements, whoami } from "@/lib/profile";
import { getAchievement } from "@/lib/achievements";

export const prerender = false;

export const GET: APIRoute = async ({ url }) => {
  const slug = url.searchParams.get("slug") ?? whoami().slug;
  if (!slug) {
    return Response.json({ error: "no slug" }, { status: 400 });
  }
  const items = readUserAchievements(slug).map((u) => ({
    ...u,
    definition: getAchievement(u.achievement_id),
  }));
  return Response.json(items);
};
