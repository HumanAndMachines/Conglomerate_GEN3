import type { APIRoute } from "astro";
import { whoami } from "@/lib/profile";

export const prerender = false;

export const GET: APIRoute = async () => {
  const me = whoami();
  if (me.slug) {
    return Response.json({ slug: me.slug, jmeno: me.jmeno, email: me.email });
  }
  return Response.json({ slug: null, candidates: me.candidates ?? [] });
};
