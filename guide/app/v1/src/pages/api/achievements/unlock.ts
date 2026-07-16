import type { APIRoute } from "astro";
import { whoami, writeUserAchievement } from "@/lib/profile";

export const prerender = false;

interface UnlockBody {
  achievement_id?: string;
  lesson_id?: string;
  slug?: string;
}

export const POST: APIRoute = async ({ request }) => {
  let body: UnlockBody = {};
  try {
    body = (await request.json()) as UnlockBody;
  } catch {
    return Response.json({ ok: false, error: "Invalid JSON" }, { status: 400 });
  }
  const id = body.achievement_id;
  if (!id) return Response.json({ ok: false, error: "Missing achievement_id" }, { status: 400 });

  const slug = body.slug ?? whoami().slug;
  if (!slug) {
    // Shared Conglomerate Guide is intentionally usable before a colleague has
    // a writable profile directory. Persist completion in browser localStorage;
    // treat server-side achievement persistence as optional enhancement.
    return Response.json({
      ok: true,
      persistence: "browser-local",
      alreadyUnlocked: false,
    });
  }

  const result = writeUserAchievement(slug, id, body.lesson_id);
  if (!result.ok) {
    return Response.json({ ok: false, error: result.error }, { status: 400 });
  }
  return Response.json({
    ok: true,
    file: result.file,
    alreadyUnlocked: Boolean(result.alreadyUnlocked),
  });
};
